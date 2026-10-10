import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureFailedSearchResponse, rememberFailedResponse } from './failure-evidence.ts';
import { inspectFailureEvidence, summarizeFailureEvidence } from './inspect-failure-evidence.ts';

const roots: string[] = [];
const setting = process.env.CRAFT_SEARCH_FAILURE_EVIDENCE;
afterEach(() => {
  if (setting === undefined) delete process.env.CRAFT_SEARCH_FAILURE_EVIDENCE;
  else process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = setting;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'evidence-inspect-')), '.search-failure-evidence');
  roots.push(join(path, '..'));
  return path;
};

const body = [
  'data: {"type":"QUERY_SECRET","delta":"QUERY_SECRET"}', '',
  'data: {"type":"response.completed","response":null}', '',
  'data: {"type":"response.failed","response":{"error":{"code":"tool_unavailable","message":"QUERY_SECRET"}}}', '',
  'data: {"type":"response.failed","response":{"error":{"code":"QUERY_SECRET"}}}', '',
  'data: {invalid QUERY_SECRET', '',
  'data: [DONE]', '',
].join('\n');

function syntheticEnvelope(now: number) {
  return JSON.stringify({ version: 1, at: now, response: {
    status: 502, contentType: 'text/event-stream; QUERY_SECRET', raw: body,
  } });
}

describe('encrypted evidence inspector', () => {
  it('reports allowlisted shape but never query, provider message, or unknown code', () => {
    const now = Date.now();
    const id = `${now}-00000000-0000-4000-8000-000000000001`;
    const result = summarizeFailureEvidence(id, syntheticEnvelope(now), now);
    expect(result).toMatchObject({
      id, httpStatus: 502, contentType: 'text/event-stream', format: 'sse',
      eventTypes: { unrecognized: 1, 'response.completed': 1, 'response.failed': 2 },
      parsedEvents: 4, malformedEvents: 1, doneMarkers: 1,
      hasCompletionPayload: false, hasTerminalFailure: true,
      knownErrorCodes: ['tool_unavailable'],
    });
    expect(JSON.stringify(result)).not.toContain('QUERY_SECRET');
    expect(JSON.stringify(result)).not.toContain('message');
  });

  it('fails closed on expired, invalid, or untrusted envelope metadata', () => {
    const now = Date.now();
    const id = `${now}-00000000-0000-4000-8000-000000000001`;
    expect(() => summarizeFailureEvidence(`${now}-../bad`, syntheticEnvelope(now), now)).toThrow('Invalid evidence id');
    expect(() => summarizeFailureEvidence(id, syntheticEnvelope(now), now + 73 * 3_600_000)).toThrow('outside retention');
    expect(() => summarizeFailureEvidence(id, syntheticEnvelope(now).replace('"at":' + now, '"at":0'), now)).toThrow('Invalid evidence envelope');
    expect(() => summarizeFailureEvidence(id, 'QUERY_SECRET', now)).toThrow('Invalid evidence envelope');
  });

  it('inspects a real DPAPI capture in memory under the same identity, without plaintext on disk or output', () => {
    if (process.platform !== 'win32') return;
    process.env.CRAFT_SEARCH_FAILURE_EVIDENCE = '1';
    const path = root();
    const error = new Error('provider refused');
    rememberFailedResponse(error, { raw: body, status: 502, contentType: 'text/event-stream; QUERY_SECRET' });
    const id = captureFailedSearchResponse(error, path);
    expect(id).not.toBeNull();
    const [file] = readdirSync(path);
    expect(readFileSync(join(path, file!)).includes(Buffer.from('QUERY_SECRET'))).toBe(false);
    const report = inspectFailureEvidence(path, id!);
    expect(report.eventTypes['response.failed']).toBe(2);
    expect(report.knownErrorCodes).toEqual(['tool_unavailable']);
    expect(JSON.stringify(report)).not.toContain('QUERY_SECRET');
    const script = join(import.meta.dir, '../../../../../scripts/inspect-search-failure-evidence.ts');
    const cli = spawnSync(process.execPath, ['run', script, '--workspace-root', dirname(path), '--id', id!],
      { encoding: 'utf8', timeout: 8_000 });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).knownErrorCodes).toEqual(['tool_unavailable']);
    expect(cli.stdout + cli.stderr).not.toContain('QUERY_SECRET');
    expect(() => inspectFailureEvidence(path, `${id}/../other`)).toThrow('Invalid evidence id');
  }, 20_000);
});
