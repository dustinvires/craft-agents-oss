/**
 * Local-only, structurally redacted inspection of opt-in search failure evidence.
 * Example: bun run scripts/inspect-search-failure-evidence.ts --workspace-root C:/path/to/workspace --id 1791648000000-00000000-0000-4000-8000-000000000001
 * Do not use a command that prints the decrypted body to a shell or transcript.
 */
import { join } from 'node:path';
import { inspectFailureEvidence } from '../packages/pi-agent-server/src/tools/search/inspect-failure-evidence.ts';

const workspaceFlag = process.argv.indexOf('--workspace-root');
const idFlag = process.argv.indexOf('--id');
if (workspaceFlag < 0 || idFlag < 0 || !process.argv[workspaceFlag + 1] || !process.argv[idFlag + 1]) {
  console.error('Usage: --workspace-root <local workspace> --id <encrypted evidence id>');
  process.exit(2);
}
try {
  const root = join(process.argv[workspaceFlag + 1]!, '.search-failure-evidence');
  const report = inspectFailureEvidence(root, process.argv[idFlag + 1]!);
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error('Encrypted evidence cannot be inspected here (missing, expired, invalid, or wrong OS identity).');
  process.exitCode = 1;
}
