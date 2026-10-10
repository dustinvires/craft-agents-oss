import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFailedSearchResponse, pruneFailureEvidence, rememberFailedResponse } from './failure-evidence.ts';
import { createSearchTool } from './create-search-tool.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';

const dirs: string[] = [];
const priorSetting = process.env.CRAFT_SEARCH_FAILURE_EVIDENCE;
afterEach(() => {
  if (priorSetting === undefined) delete process.env.CRAFT_SEARCH_FAILURE_EVIDENCE;
  else process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = priorSetting;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'search-evidence-test-'));
  dirs.push(root);
  return root;
};

const decryptScript = [
  'Add-Type -AssemblyName System.Security',
  '$raw = [Console]::In.ReadToEnd()',
  '$cipher = [Convert]::FromBase64String($raw)',
  '$clear = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))',
].join('; ');

describe('opt-in search failure evidence', () => {
  it('never creates evidence when disabled', () => {
    delete process.env.CRAFT_SEARCH_FAILURE_EVIDENCE;
    const root = join(tempRoot(), '.search-failure-evidence');
    const error = new Error('failed');
    rememberFailedResponse(error, { raw: 'private page and query', status: 400, contentType: 'text/plain' });
    expect(captureFailedSearchResponse(error, root)).toBeNull();
    expect(existsSync(root)).toBe(false);
  });

  it('persists only DPAPI ciphertext on all-provider failure and omits the raw body from tool output', async () => {
    if (process.platform !== 'win32') return;
    process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = '1';
    const root = join(tempRoot(), '.search-failure-evidence');
    const primary = {
      name: 'ChatGPT',
      async search() {
        const error = new Error('HTTP 400 rejected');
        rememberFailedResponse(error, {
          raw: 'PRIVATE QUERY + PROVIDER BODY: an unusual response', status: 400, contentType: 'text/event-stream',
        });
        throw error;
      },
    };
    const fallback = { name: 'DuckDuckGo', async search(): Promise<never> { throw new Error('DDG rejected'); } };
    let message = '';
    try {
      await createSearchTool(primary, fallback, { evidenceRoot: root }).execute('id', { query: 'PRIVATE QUERY' });
    } catch (error) { message = String(error); }
    expect(message).toContain('encrypted evidence id=');
    expect(message).not.toContain('PROVIDER BODY');
    const [filename] = readdirSync(root);
    expect(filename).toMatch(/\.dpapi$/);
    const acl = spawnSync('icacls.exe', [root], { encoding: 'utf8', timeout: 8_000 });
    expect(acl.status).toBe(0);
    expect((acl.stdout.match(/\(F\)/g) || []).length).toBe(1); // current DPAPI identity only
    expect(acl.stdout.toLowerCase()).not.toContain('everyone');
    const cipher = readFileSync(join(root, filename!));
    expect(cipher.includes(Buffer.from('PRIVATE QUERY'))).toBe(false);
    expect(cipher.includes(Buffer.from('PROVIDER BODY'))).toBe(false);
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(decryptScript, 'utf16le').toString('base64'),
    ], { input: cipher.toString('base64'), encoding: 'utf8', timeout: 8_000 });
    expect(result.status).toBe(0);
    const decoded = JSON.parse(result.stdout);
    expect(decoded.response.status).toBe(400);
    expect(decoded.response.raw).toContain('PRIVATE QUERY + PROVIDER BODY');
  }, 15_000);

  it('encrypts an OpenAI-compatible HTTP failure without quoting its raw body', async () => {
    if (process.platform !== 'win32') return;
    process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = '1';
    const root = join(tempRoot(), '.search-failure-evidence');
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":{"message":"PRIVATE QUERY AND PAGE"}}', {
      status: 403, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    try {
      const provider = new ResponsesApiSearchProvider({ apiBase: 'https://example.invalid/v1', apiKey: 'synthetic' });
      const fallback = { name: 'DuckDuckGo', async search(): Promise<never> { throw new Error('fallback rejected'); } };
      let message = '';
      try { await createSearchTool(provider, fallback, { evidenceRoot: root }).execute('id', { query: 'PRIVATE QUERY' }); }
      catch (error) { message = String(error); }
      expect(message).toContain('Web search failed:');
      expect(message).toContain('HTTP 403');
      expect(message).toContain('encrypted evidence id=');
      expect(message).not.toContain('PRIVATE QUERY');
      expect(message).not.toContain('PRIVATE QUERY AND PAGE');
      const files = readdirSync(root);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(root, files[0]!)).includes(Buffer.from('PRIVATE QUERY'))).toBe(false);
    } finally {
      globalThis.fetch = priorFetch;
    }
  }, 15_000);

  it('does not retain a rejected primary response if fallback succeeds', async () => {
    process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = '1';
    const root = join(tempRoot(), '.search-failure-evidence');
    const primary = { name: 'ChatGPT', async search(): Promise<never> {
      const error = new Error('provider rejected');
      rememberFailedResponse(error, { raw: 'PRIVATE QUERY', status: 400, contentType: 'text/plain' });
      throw error;
    } };
    const fallback = { name: 'DuckDuckGo', async search() {
      return [{ title: 'Found', url: 'https://example.com', description: 'ok' }];
    } };
    const result = await createSearchTool(primary, fallback, { evidenceRoot: root })
      .execute('id', { query: 'PRIVATE QUERY' });
    expect((result.content[0] as { text: string }).text).toContain('Found');
    expect(existsSync(root)).toBe(false);
  });

  it('prunes only expired named files, leaves unrelated files, and bounds file count', () => {
    const root = join(tempRoot(), '.search-failure-evidence');
    mkdirSync(root);
    const now = 1791648000000;
    const old = `${now - 73 * 60 * 60 * 1000}-00000000-0000-4000-8000-000000000001.dpapi`;
    writeFileSync(join(root, old), 'old ciphertext');
    writeFileSync(join(root, 'README.txt'), 'unrelated');
    for (let i = 0; i < 53; i++) {
      const name = `${now - i * 1000}-${String(i).padStart(8,'0')}-0000-4000-8000-000000000001.dpapi`;
      writeFileSync(join(root, name), 'ciphertext');
    }
    pruneFailureEvidence(root, now);
    expect(existsSync(join(root, old))).toBe(false);
    expect(existsSync(join(root, 'README.txt'))).toBe(true);
    expect(readdirSync(root).filter(f => f.endsWith('.dpapi')).length).toBe(50);
    pruneFailureEvidence(root, now, 1);
    expect(readdirSync(root).filter(f => f.endsWith('.dpapi')).length).toBe(49);
  });
});
