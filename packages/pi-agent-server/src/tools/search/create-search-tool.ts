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

// A stalled provider must not hold an agent turn indefinitely. Provider-level request
// timeouts still apply; this caps the entire primary + fallback sequence.
const SEARCH_DEADLINE_MS = 90_000;

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
  options?: { deadlineMs?: number },
): ToolDefinition<typeof schema> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information. Returns titles, URLs, and snippets. Use for current information, documentation lookups, or fact-checking.',
    promptSnippet:
      'Use web_search for up-to-date information, documentation lookups, or fact-checking. Returns titles, URLs, and snippets. Accepts a query string and optional count (1-10).',
    parameters: schema,
    async execute(toolCallId, params) {
      const { query } = params;
      const count = Math.max(1, Math.min(10, params.count ?? 5));
      const deadlineMs = Math.max(1, options?.deadlineMs ?? SEARCH_DEADLINE_MS);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      const deadline = new Promise<{ content: Array<{ type: 'text'; text: string }>; details: { isError: boolean } }>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({
            content: [{ type: 'text', text: `Search timed out after ${deadlineMs} ms for "${query}" (primary and fallback combined).` }],
            details: { isError: true },
          });
        }, deadlineMs);
      });

      const search = async () => {
        try {
          const results = await provider.search(query, count, controller.signal);
          return formatResults(query, provider.name, results);
        } catch (err) {
          const primaryMsg = err instanceof Error ? err.message : String(err);

          const canFallback = !timedOut && provider.name !== fallbackProvider.name;
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
              const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Search failed for "${query}": primary (${provider.name}) failed with "${formatErrorSnippet(primaryMsg, 400)}"; fallback (${fallbackProvider.name}) failed with "${formatErrorSnippet(fallbackMsg, 400)}"`,
                  },
                ],
                details: { isError: true },
              };
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Search failed for "${query}": ${formatErrorSnippet(primaryMsg, 400)}`,
              },
            ],
            details: { isError: true },
          };
        }
      };

      try {
        return await Promise.race([search(), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
