/**
 * Responses API search provider — works with any endpoint that implements the
 * OpenAI Responses API format with a built-in `web_search` tool.
 *
 * Supports:
 *   - api.openai.com/v1  (OpenAI direct)
 *   - openrouter.ai/api/v1  (OpenRouter)
 *   - Any future Responses API-compatible endpoint
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';
import { rememberFailedResponse } from '../failure-evidence.ts';
import { parseResponsesApiResults, type ResponsesApiResponse } from './responses-api-parser.ts';

const DEFAULT_SEARCH_MODEL = 'gpt-4o-mini';

export interface ResponsesApiSearchConfig {
  /** Base URL without trailing slash (e.g. "https://api.openai.com/v1") */
  apiBase: string;
  /** Bearer token for Authorization header */
  apiKey: string;
  /** Model to use for the search call (default: gpt-4o-mini) */
  model?: string;
  /** Additional headers to include in the request */
  extraHeaders?: Record<string, string>;
  /** Display name for this provider (default: derived from apiBase) */
  displayName?: string;
}

export class ResponsesApiSearchProvider implements WebSearchProvider {
  name: string;

  constructor(private config: ResponsesApiSearchConfig) {
    this.name = config.displayName || deriveDisplayName(config.apiBase);
  }

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const response = await fetch(`${this.config.apiBase}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.extraHeaders,
      },
      body: JSON.stringify({
        model: this.config.model || DEFAULT_SEARCH_MODEL,
        tools: [{ type: 'web_search' }],
        input: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description.`,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });

    const raw = await readBoundedBody(response);
    if (!response.ok) {
      const error = new Error(`Search provider HTTP ${response.status}`);
      rememberFailedResponse(error, { raw, status: response.status, contentType: response.headers.get('content-type') || 'unknown' });
      throw error;
    }

    try {
      const data = JSON.parse(raw) as ResponsesApiResponse;
      return parseResponsesApiResults(data, query, count);
    } catch {
      const error = new Error('Search provider returned an invalid response payload');
      rememberFailedResponse(error, { raw, status: response.status, contentType: response.headers.get('content-type') || 'unknown' });
      throw error;
    }
  }
}

// Do not materialize unbounded provider error/HTML responses in memory.
async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel().catch(() => {});
        throw new Error('Search provider response exceeded the 2 MiB safety limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * @deprecated Use `ResponsesApiSearchProvider` instead.
 * Kept as a re-export for backwards compatibility with existing imports.
 */
export const OpenAISearchProvider = ResponsesApiSearchProvider;

function deriveDisplayName(apiBase: string): string {
  if (apiBase.includes('openrouter')) return 'OpenRouter';
  if (apiBase.includes('openai.com')) return 'OpenAI';
  return 'Web Search';
}
