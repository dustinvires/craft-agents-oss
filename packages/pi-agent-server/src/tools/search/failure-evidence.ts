import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Opt-in, Windows-only failure escrow. Raw provider bodies must never go into
 * tool results, event buses, logs, arguments, or plaintext files. The captured
 * bytes go via stdin to Windows DPAPI (CurrentUser); only ciphertext reaches
 * the workspace. Another OS account/machine cannot decrypt it. Fail closed if
 * DPAPI is unavailable. This is not protection against compromise of the
 * Craft service's own OS identity, memory, or filesystem backups.
 */
const MAX_BODY_BYTES = 64 * 1024;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const MAX_FILES = 50;
const FILENAME = /^([0-9]{13})-([a-f0-9-]{36})\.dpapi$/;
const candidates = new WeakMap<Error, { raw: string; status: number; contentType: string }>();
const restrictDirectoryScript = [
  '$ErrorActionPreference = "Stop"',
  '$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))',
  '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$acl = New-Object Security.AccessControl.DirectorySecurity',
  '$acl.SetAccessRuleProtection($true,$false)',
  '$flags = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
  '$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl",$flags,[Security.AccessControl.PropagationFlags]::None,"Allow")',
  '$acl.AddAccessRule($rule)',
  '[IO.Directory]::SetAccessControl($root,$acl)',
  '[Console]::Out.Write("ok")',
].join('; ');
const protectScript = [
  'Add-Type -AssemblyName System.Security',
  '$raw = [Console]::In.ReadToEnd()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$cipher = [System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher))',
].join('; ');

export function rememberFailedResponse(error: Error, response: { raw: string; status: number; contentType: string }): void {
  // Never retain an unbounded response body even in process memory.
  const bytes = Buffer.from(response.raw, 'utf8').subarray(0, MAX_BODY_BYTES);
  candidates.set(error, { ...response, raw: new TextDecoder().decode(bytes) });
}

export function carryFailedResponse(from: unknown, to: Error): void {
  if (from instanceof Error) {
    const candidate = candidates.get(from);
    if (candidate) candidates.set(to, candidate);
  }
}

export function pruneFailureEvidence(root: string, now = Date.now(), reserve = 0): void {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
  const files: Array<{ name: string; time: number }> = [];
  for (const name of readdirSync(root)) {
    const match = FILENAME.exec(name);
    if (!match) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue; // Never follow an untrusted symlink.
      const created = Number(match[1]);
      if (created > now || now - created >= RETENTION_MS) {
        unlinkSync(path);
      } else {
        files.push({ name, time: created });
      }
    } catch { /* Best effort; don't delay an agent's failed search. */ }
  }
  for (const file of files.sort((a, b) => b.time - a.time).slice(MAX_FILES - reserve)) {
    try { unlinkSync(join(root, file.name)); } catch { /* Next sweep retries. */ }
  }
}

export function captureFailedSearchResponse(error: unknown, root?: string): string | null {
  if (process.env.CRAFT_SEARCH_FAILURE_EVIDENCE !== '1' || process.platform !== 'win32' || !root) return null;
  const response = error instanceof Error ? candidates.get(error) : undefined;
  if (!response) return null;
  try {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ version: 1, at: now, response }), 'utf8');
    const protectedResult = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protectScript, 'utf16le').toString('base64'),
    ], {
      input: payload.toString('base64'), encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 128 * 1024,
    });
    // Never include stderr in an exception: the provider body must not enter a log.
    if (protectedResult.status !== 0 || protectedResult.error) return null;
    const output = (protectedResult.stdout || '').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return null;
    const cipher = Buffer.from(output, 'base64');
    if (!cipher.length || cipher.includes(payload)) return null;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory()) return null;
    // chmod is not a Windows ACL. Replace inherited/granted directory access
    // with only the DPAPI current identity, inherited by new ciphertext files.
    const secured = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(restrictDirectoryScript, 'utf16le').toString('base64'),
    ], {
      input: Buffer.from(root, 'utf8').toString('base64'), encoding: 'utf8',
      timeout: 8_000, windowsHide: true, maxBuffer: 4 * 1024,
    });
    if (secured.status !== 0 || secured.error || secured.stdout?.trim() !== 'ok') return null;
    pruneFailureEvidence(root, now, 1); // leave one slot for the new ciphertext
    const id = `${now}-${randomUUID()}`;
    const path = join(root, `${id}.dpapi`);
    writeFileSync(path, cipher, { flag: 'wx', mode: 0o600 });
    return id;
  } catch {
    // Encryption/ACL/storage failure is no reason to spill plaintext or hide
    // the original provider failure. No evidence marker is reported.
    return null;
  }
}

export const FAILURE_EVIDENCE_RETENTION_MS = RETENTION_MS;
