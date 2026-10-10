import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { createSearchTool } from './create-search-tool.ts';
import type { WebSearchProvider } from './types.ts';

describe('createSearchTool', () => {
  it('keeps canonical tool identity', () => {
    const provider: WebSearchProvider = {
      name: 'Mock',
      async search() {
        return [];
      },
    };

    const tool = createSearchTool(provider);

    expect(tool.name).toBe('web_search');
    expect(tool.label).toBe('Web Search');
    expect(tool.description).toContain('Search the web');
  });

  it('validates arguments through the SDK TypeBox build (coercion + required checks)', () => {
    const provider: WebSearchProvider = {
      name: 'Mock',
      async search() {
        return [];
      },
    };
    const tool = createSearchTool(provider);
    const call = (args: unknown) =>
      validateToolArguments(tool as any, { type: 'toolCall', id: 'call-1', name: tool.name, arguments: args } as any);

    // The SDK only coerces model-emitted argument types (e.g. "3" -> 3) for schemas
    // built with its own TypeBox; a schema from a second TypeBox copy would be
    // validated strictly and reject this call instead.
    expect(call({ query: 'craft', count: '3' })).toEqual({ query: 'craft', count: 3 });
    expect(() => call({ count: 3 })).toThrow(/Validation failed/);
    expect(() => call({ query: 'craft', count: 99 })).toThrow(/Validation failed/);
  });

  it('clamps count to [1, 10] and formats results', async () => {
    let capturedCount = 0;
    const provider: WebSearchProvider = {
      name: 'MockProvider',
      async search(query, count) {
        capturedCount = count;
        return [{ title: `Result for ${query}`, url: 'https://example.com', description: 'desc' }];
      },
    };

    const tool = createSearchTool(provider);
    const result = await tool.execute('tool-1', { query: 'craft', count: 99 });

    expect(capturedCount).toBe(10);
    expect(result.details?.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any).text).toContain('(via MockProvider)');
  });

  it('automatically falls back when primary provider fails', async () => {
    const provider: WebSearchProvider = {
      name: 'OpenAI',
      async search() {
        throw new Error('401 missing scope');
      },
    };

    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        return [{ title: 'Fallback hit', url: 'https://fallback.example', description: 'ok' }];
      },
    };

    const tool = createSearchTool(provider, fallbackProvider);
    const result = await tool.execute('tool-2', { query: 'craft', count: 5 });

    expect(result.details?.isError).toBeUndefined();
    expect((result.content[0] as any).text).toContain('automatically fell back to DuckDuckGo');
    expect((result.content[0] as any).text).toContain('401 missing scope');
    expect((result.content[0] as any).text).toContain('https://fallback.example');
  });

  it('marks failures as errors when primary and fallback both fail', async () => {
    const provider: WebSearchProvider = {
      name: 'OpenAI',
      async search() {
        throw new Error('primary boom');
      },
    };

    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error('fallback boom');
      },
    };

    const tool = createSearchTool(provider, fallbackProvider);
    await expect(tool.execute('tool-3', { query: 'craft', count: -1 }))
      .rejects.toThrow(/Web search failed: primary \(OpenAI\).*fallback \(DuckDuckGo\)/);
  });

  it('truncates oversized provider errors in the tool result', async () => {
    const hugePrimary = `primary detail ${'x'.repeat(5_000)}`;
    const hugeFallback = `fallback detail ${'y'.repeat(5_000)}`;
    const provider: WebSearchProvider = {
      name: 'OpenAI',
      async search() {
        throw new Error(hugePrimary);
      },
    };

    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error(hugeFallback);
      },
    };

    const tool = createSearchTool(provider, fallbackProvider);
    let text = '';
    try { await tool.execute('tool-5', { query: 'craft' }); }
    catch (error) { text = error instanceof Error ? error.message : String(error); }
    expect(text).toContain('primary detail');
    expect(text).toContain('fallback detail');
    expect(text).toContain('…');
    // Both messages capped at 400 chars — the combined error stays compact.
    expect(text.length).toBeLessThan(1_000);
  });

  it('returns a visible deadline error and aborts a stalled primary instead of starting fallback', async () => {
    let passedSignal: AbortSignal | undefined;
    let fallbackCalls = 0;
    const provider: WebSearchProvider = {
      name: 'Stalled',
      async search(_query, _count, signal) {
        passedSignal = signal;
        return new Promise(() => {});
      },
    };
    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        fallbackCalls++;
        return [];
      },
    };

    await expect(createSearchTool(provider, fallbackProvider, { deadlineMs: 10 })
      .execute('call-stall', { query: 'test' }))
      .rejects.toThrow('Web search stalled: No result after 10 ms; provider status unknown.');
    expect(passedSignal?.aborted).toBe(true);
    expect(fallbackCalls).toBe(0);
  });

  it('applies the same deadline across primary and stalled fallback', async () => {
    let fallbackSignal: AbortSignal | undefined;
    const provider: WebSearchProvider = { name: 'Broken', async search() { throw new Error('primary failed'); } };
    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search(_query, _count, signal) {
        fallbackSignal = signal;
        return new Promise(() => {});
      },
    };
    await expect(createSearchTool(provider, fallbackProvider, { deadlineMs: 10 })
      .execute('call-fallback-stall', { query: 'test' }))
      .rejects.toThrow('Web search stalled: No result after 10 ms; provider status unknown.');
    expect(fallbackSignal?.aborted).toBe(true);
  });

  it('does not recurse fallback when provider is already fallback provider', async () => {
    const ddgProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error('ddg boom');
      },
    };

    const tool = createSearchTool(ddgProvider, ddgProvider);
    await expect(tool.execute('tool-4', { query: 'craft' }))
      .rejects.toThrow('Web search failed: ddg boom');
  });

  it('lets a slow but healthy provider finish before the final safety limit', async () => {
    const provider: WebSearchProvider = {
      name: 'Slow',
      async search() {
        await new Promise(resolve => setTimeout(resolve, 35));
        return [{ title: 'Good result', url: 'https://example.com', description: 'ok' }];
      },
    };
    const result = await createSearchTool(provider, provider, { deadlineMs: 120 })
      .execute('call-slow', { query: 'test' });
    expect((result.content[0] as any).text).toContain('Good result');
  });

  it('does not notify a failure or try fallback when the user cancels', async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    const provider: WebSearchProvider = {
      name: 'Cancel',
      async search(_query, _count, signal) {
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    };
    const fallback: WebSearchProvider = { name: 'DuckDuckGo', async search() { fallbackCalls++; return []; } };
    const result = createSearchTool(provider, fallback, { deadlineMs: 200 })
      .execute('call-cancel', { query: 'test' }, controller.signal);
    controller.abort(new Error('User cancelled'));
    await expect(result).rejects.toThrow('User cancelled');
    expect(fallbackCalls).toBe(0);
  });
});
