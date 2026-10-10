import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Human-safe structural report ONLY. No arbitrary provider text leaves this function. */
export interface FailureEvidenceInspection {
  id: string;
  ageHours: number;
  httpStatus: number;
  contentType: string;
  bodyBytes: number;
  format: 'sse' | 'json' | 'other';
  eventTypes: Record<string, number>;
  parsedEvents: number;
  malformedEvents: number;
  doneMarkers: number;
  hasCompletionPayload: boolean;
  hasTerminalFailure: boolean;
  knownErrorCodes: string[];
}

const ID = /^([0-9]{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_PLAINTEXT_BYTES = 96 * 1024;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const KNOWN_TYPES = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.done',
  'response.failed', 'response.incomplete', 'response.output_item.added',
  'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done', 'response.web_search_call.in_progress',
  'response.web_search_call.completed', 'error',
]);
const KNOWN_CODES = new Set(['tool_unavailable', 'model_not_found', 'invalid_request_error', 'rate_limit_exceeded', 'unsupported_model']);
const KNOWN_CONTENT_TYPES = new Set(['application/json', 'text/event-stream', 'text/plain']);
const unprotectScript = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$clear = [Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($clear))',
].join('; ');

function knownCode(value: unknown, into: Set<string>): void {
  if (typeof value === 'string' && KNOWN_CODES.has(value)) into.add(value);
}

export function summarizeFailureEvidence(id: string, decrypted: string, now = Date.now()): FailureEvidenceInspection {
  const match = ID.exec(id);
  if (!match) throw new Error('Invalid evidence id');
  const at = Number(match[1]);
  if (at > now || now - at >= RETENTION_MS) throw new Error('Evidence id is outside retention window');
  if (Buffer.byteLength(decrypted, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('Evidence exceeds size limit');
  let envelope: any;
  try { envelope = JSON.parse(decrypted); }
  catch { throw new Error('Invalid evidence envelope'); }
  if (envelope?.version !== 1 || envelope?.at !== at || typeof envelope?.response?.raw !== 'string') {
    throw new Error('Invalid evidence envelope');
  }
  const raw = envelope.response.raw as string;
  const status = envelope.response.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Invalid evidence envelope');
  const suppliedType = String(envelope.response.contentType || '').split(';')[0]!.trim().toLowerCase();
  const contentType = KNOWN_CONTENT_TYPES.has(suppliedType) ? suppliedType : 'other';
  const report: FailureEvidenceInspection = {
    id, ageHours: Math.floor((now - at) / 3_600_000), httpStatus: status, contentType,
    bodyBytes: Buffer.byteLength(raw, 'utf8'), format: 'other', eventTypes: {},
    parsedEvents: 0, malformedEvents: 0, doneMarkers: 0,
    hasCompletionPayload: false, hasTerminalFailure: false, knownErrorCodes: [],
  };
  const codes = new Set<string>();
  const sse = contentType === 'text/event-stream' || /^event:|^data:|\n\s*data:/m.test(raw);
  if (sse) {
    report.format = 'sse';
    for (const chunk of raw.replace(/\r\n?/g, '\n').split('\n\n')) {
      const lines = chunk.split('\n').map(line => line.trim()).filter(line => line.startsWith('data:'));
      for (const line of lines) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') { report.doneMarkers++; continue; }
        let event: any;
        try { event = JSON.parse(data); }
        catch { report.malformedEvents++; continue; }
        report.parsedEvents++;
        const kind = typeof event?.type === 'string' && KNOWN_TYPES.has(event.type) ? event.type : 'unrecognized';
        report.eventTypes[kind] = (report.eventTypes[kind] || 0) + 1;
        if ((kind === 'response.completed' || kind === 'response.done') && event?.response && typeof event.response === 'object') {
          report.hasCompletionPayload = true;
        }
        if (kind === 'response.failed' || kind === 'response.incomplete' || kind === 'error') report.hasTerminalFailure = true;
        knownCode(event?.response?.error?.code ?? event?.error?.code, codes);
      }
    }
  } else {
    try {
      const json = JSON.parse(raw);
      report.format = 'json';
      knownCode(json?.error?.code ?? json?.code, codes);
      // HTTP failure bodies are not proof of a search-level terminal event.
    } catch { /* No raw parse error message in the inspection report. */ }
  }
  report.knownErrorCodes = [...codes].sort();
  return report;
}

/** Decrypt only in a same-identity subprocess, inspect in memory, emit safe shape. */
export function inspectFailureEvidence(root: string, id: string): FailureEvidenceInspection {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI required');
  if (!ID.test(id)) throw new Error('Invalid evidence id');
  const path = join(root, `${id}.dpapi`);
  try {
    if (!lstatSync(root).isDirectory() || !lstatSync(path).isFile()) throw new Error('Invalid evidence storage');
    const cipher = readFileSync(path);
    if (!cipher.length || cipher.length > MAX_CIPHERTEXT_BYTES) throw new Error('Evidence exceeds size limit');
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(unprotectScript, 'utf16le').toString('base64'),
    ], { input: cipher.toString('base64'), encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: MAX_PLAINTEXT_BYTES * 2 });
    if (result.status !== 0 || result.error) throw new Error('Cannot decrypt evidence under this OS identity');
    const clear = (result.stdout || '').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clear)) throw new Error('Invalid decrypted evidence');
    const bytes = Buffer.from(clear, 'base64');
    if (!bytes.length || bytes.length > MAX_PLAINTEXT_BYTES) throw new Error('Evidence exceeds size limit');
    return summarizeFailureEvidence(id, bytes.toString('utf8'));
  } catch {
    // Filesystem / crypto exception paths can include input paths or provider
    // data. Never let them become tool output, notification, or logs.
    throw new Error('Could not inspect evidence (missing, expired, invalid, or wrong OS identity)');
  }
}
