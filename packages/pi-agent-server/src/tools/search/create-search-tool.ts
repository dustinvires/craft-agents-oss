/**
 * Creates a `web_search` ToolDefinition backed by the given search provider.
 *
 * The tool name is always `web_search` regardless of the underlying provider,
 * so the model doesn't need to know which backend is used.
 */

import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WebSearchProvider, WebSearchResult } from './types.ts';
import { DDGSearchProvider } from './providers/ddg.ts';
import { captureFailedSearchResponse } from './failure-evidence.ts';

// A slow search is not proof of provider failure. Allow slow searches to finish,
// but do not leave an agent turn stuck indefinitely if a provider never settles.
const SEARCH_DEADLINE_MS = 300_000;
const SEARCH_STALLED = 'Web search stalled:';
const SEARCH_FAILED = 'Web search failed:';

const schema = Type.Object({
  query: Type.String({ description: 'The search query' }),
  count: Type.Optional(
    Type.Number({
      description: 'Max results (1-10, default 5)',
      minimum: 1,
      maximum: 10,
    }),
  ),
});

function formatResults(
  query: string,
  providerName: string,
  results: WebSearchResult[],
  note?: string,
) {
  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`,
    )
    .join('\n\n');

  const noteText = note ? `${note}\n\n` : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: `${noteText}Search results for "${query}" (via ${providerName}):\n\n${formatted}`,
      },
    ],
    details: {},
  };
}

function formatErrorSnippet(message: string, max = 180): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return 'unknown error';
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function createSearchTool(
  provider: WebSearchProvider,
  fallbackProvider: WebSearchProvider = new DDGSearchProvider(),
  options?: { deadlineMs?: number; evidenceRoot?: string },
): ToolDefinition<typeof schema> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information. Returns titles, URLs, and snippets. Use for current information, documentation lookups, or fact-checking.',
    promptSnippet:
      'Use web_search for up-to-date information, documentation lookups, or fact-checking. Returns titles, URLs, and snippets. Accepts a query string and optional count (1-10).',
    parameters: schema,
    async execute(toolCallId, params, signal) {
      const { query } = params;
      const count = Math.max(1, Math.min(10, params.count ?? 5));
      const deadlineMs = Math.max(1, options?.deadlineMs ?? SEARCH_DEADLINE_MS);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) signal.throwIfAborted();
      signal?.addEventListener('abort', cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const stalledMessage = `${SEARCH_STALLED} No result after ${deadlineMs} ms; provider status unknown.`;

      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(stalledMessage));
        }, deadlineMs);
      });

      const search = async () => {
        try {
          const results = await provider.search(query, count, controller.signal);
          return formatResults(query, provider.name, results);
        } catch (err) {
          if (timedOut) throw new Error(stalledMessage);
          signal?.throwIfAborted();
          const primaryMsg = err instanceof Error ? err.message : String(err);

          const canFallback = provider.name !== fallbackProvider.name;
          if (canFallback) {
            try {
              const fallbackResults = await fallbackProvider.search(query, count, controller.signal);
              return formatResults(
                query,
                fallbackProvider.name,
                fallbackResults,
                `Primary search provider (${provider.name}) failed (${formatErrorSnippet(primaryMsg)}), automatically fell back to ${fallbackProvider.name}.`,
              );
            } catch (fallbackErr) {
              if (timedOut) throw new Error(stalledMessage);
              signal?.throwIfAborted();
              const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              const evidenceId = captureFailedSearchResponse(err, options?.evidenceRoot)
                ?? captureFailedSearchResponse(fallbackErr, options?.evidenceRoot);
              throw new Error(`${SEARCH_FAILED} primary (${provider.name}) failed with "${formatErrorSnippet(primaryMsg, 400)}"; fallback (${fallbackProvider.name}) failed with "${formatErrorSnippet(fallbackMsg, 400)}"${evidenceId ? `; encrypted evidence id=${evidenceId}` : ''}`);
            }
          }

          const evidenceId = captureFailedSearchResponse(err, options?.evidenceRoot);
          throw new Error(`${SEARCH_FAILED} ${formatErrorSnippet(primaryMsg, 400)}${evidenceId ? `; encrypted evidence id=${evidenceId}` : ''}`);
        }
      };

      try {
        return await Promise.race([search(), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
