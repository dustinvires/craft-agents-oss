import { describe, expect, it } from 'bun:test';
import { createDynamicSearchProvider } from './dynamic-provider.ts';
import type { WebSearchProvider } from './types.ts';

describe('createDynamicSearchProvider', () => {
  it('selects current credentials/model on each search and forwards the same abort signal', async () => {
    const seen: Array<{ provider: string; signal?: AbortSignal }> = [];
    let current = 'initial';
    const resolve = (): WebSearchProvider => ({
      name: current,
      async search(_query, _count, signal) {
        seen.push({ provider: current, signal });
        return [{ title: current, url: 'https://example.com', description: '' }];
      },
    });
    const dynamic = createDynamicSearchProvider(resolve);
    const first = new AbortController();
    await dynamic.search('test', 5, first.signal);
    current = 'refreshed';
    const second = new AbortController();
    await dynamic.search('test', 5, second.signal);
    expect(dynamic.name).toBe('refreshed');
    expect(seen).toEqual([
      { provider: 'initial', signal: first.signal },
      { provider: 'refreshed', signal: second.signal },
    ]);
  });
});
