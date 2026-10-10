import type { WebSearchProvider, WebSearchResult } from './types.ts';

/** Resolve credentials/model on each call, without dropping cancellation. */
export function createDynamicSearchProvider(resolve: () => WebSearchProvider): WebSearchProvider {
  return {
    get name(): string {
      return resolve().name;
    },
    search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
      return resolve().search(query, count, signal);
    },
  };
}
