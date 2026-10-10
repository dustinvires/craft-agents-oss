/** Isolated loopback fixture: real tool, adapter, server, and session RPC handlers. No LLM, network search, or production state. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WsRpcServer } from '../../server.ts';
import { registerSessionsHandlers } from '../../../handlers/rpc/sessions.ts';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { PiEventAdapter } from '../../../../../shared/src/agent/backend/pi/event-adapter.ts';
import { createSearchTool } from '../../../../../pi-agent-server/src/tools/search/create-search-tool.ts';
import type { HandlerDeps } from '../../../handlers/handler-deps.ts';

const SID = '261010-loopback-probe';
const WS = 'probe-ws';
const ROOT = process.env.PROBE_WORKSPACE_ROOT;
if (!ROOT || !process.env.PROBE_TOKEN) throw new Error('Isolated probe workspace and token required');
const folder = join(ROOT, 'sessions', SID);
mkdirSync(folder, { recursive: true });
const transcript = join(folder, 'session.jsonl');
let processing = false;
let cancels = 0;
let sends = 0;
let searches = 0;
let backgroundRunning = false;
let modeVersion = 7;
let activeTurnId = '';
let unguardedStops = 0;
const backend = new WsRpcServer({
  host: '127.0.0.1', port: 0, requireAuth: true, serverId: 'loopback-search-watchdog',
  validateToken: async token => token === process.env.PROBE_TOKEN,
});
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const manager = {
  waitForInit: async () => {},
  getSessions: () => [{ id: SID, name: 'Isolated search probe', isProcessing: processing,
    permissionMode: 'safe', enabledSourceSlugs: [], sessionStatus: 'in_progress', workspaceId: WS }],
  getSessionPermissionModeState: () => ({ permissionMode: 'safe', modeVersion }),
  listBackgroundTasks: () => backgroundRunning ? [{ taskId: 'fixture-task', status: 'running' }] : [],
  cancelProcessing: async () => { unguardedStops++; processing = false; return true; },
  cancelReadOnlyTurn: async (sid: string, turnId: string, version: number) => {
    if (sid !== SID || turnId !== activeTurnId || version !== modeVersion || backgroundRunning || !processing) return false;
    processing = false; cancels++; return true;
  },
  sendMessage: async (sid: string, message: string, _a: unknown, _b: unknown, _c: unknown,
                      _d: unknown, _e: unknown, onAck: (id: string) => void) => {
    if (sid !== SID) throw new Error('unknown session');
    sends++;
    const id = `msg-loopback-${sends}`;
    appendFileSync(transcript, JSON.stringify({ id, type: 'user', content: message }) + '\n');
    onAck(id);
    processing = true;
    backend.push(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: WS }, {
      type: 'user_message', sessionId: SID, status: 'accepted',
      message: { id, content: message }, permissionModeAtStart: 'safe', modeVersionAtStart: 7,
    });
    setTimeout(() => appendFileSync(transcript, JSON.stringify({ type: 'assistant', content: 'Resumed safely' }) + '\n'), 150);
  },
};
registerSessionsHandlers(backend, {
  sessionManager: manager,
  platform: { logger: quiet },
} as unknown as HandlerDeps);
await backend.listen();
process.stdout.write(JSON.stringify({ url: `ws://127.0.0.1:${backend.port}`, workspace: WS, sessionId: SID }) + '\n');

const writeRow = (row: Record<string, unknown>) => appendFileSync(transcript, JSON.stringify(row) + '\n');
function push(event: Record<string, unknown>) {
  backend.push(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: WS }, { ...event, sessionId: SID });
}
async function search(fallbackSucceeds: boolean) {
  processing = true;
  const start = { id: `msg-loopback-${fallbackSucceeds ? 'fallback' : 'failure'}-${++searches}`, type: 'user', content: 'Read-only public search' };
  writeRow(start);
  activeTurnId = start.id;
  push({ type: 'user_message', status: 'accepted', message: start,
    permissionModeAtStart: 'safe', modeVersionAtStart: modeVersion });
  const adapter = new PiEventAdapter();
  adapter.startTurn();
  const toolCallId = `search-${fallbackSucceeds ? 'fallback' : 'error'}`;
  const toolName = 'web_search';
  for (const ev of adapter.adaptEvent({ type: 'tool_execution_start', toolCallId, toolName,
    args: { query: 'SYNTHETIC_PRIVATE_QUERY' } } as any)) push(ev as Record<string, unknown>);
  const tool = createSearchTool(
    { name: 'ChatGPT', async search(): Promise<never> { throw new Error('provider unavailable'); } },
    { name: 'DuckDuckGo', async search() {
      if (!fallbackSucceeds) throw new Error('fallback unavailable');
      return [{ title: 'Fixture', url: 'https://example.invalid/', description: 'Synthetic result' }];
    } },
    { deadlineMs: 2_000 },
  );
  let result: unknown;
  let isError = false;
  try { result = await tool.execute(toolCallId, { query: 'SYNTHETIC_PRIVATE_QUERY' } as any, undefined, undefined, {} as any); }
  catch (error) { result = { content: [{ type: 'text', text: error instanceof Error ? error.message : 'unknown error' }] }; isError = true; }
  for (const ev of adapter.adaptEvent({ type: 'tool_execution_end', toolCallId, toolName, result, isError } as any)) {
    const event = ev as Record<string, unknown>;
    writeRow({ id: `msg-${toolCallId}`, type: 'tool', toolName: event.toolName, toolUseId: toolCallId,
      toolResult: event.result });
    push(event);
  }
  if (fallbackSucceeds) { processing = false; push({ type: 'complete' }); }
}
let text = '';
for await (const chunk of Bun.stdin.stream()) {
  text += new TextDecoder().decode(chunk);
  while (text.includes('\n')) {
    const cut = text.indexOf('\n');
    const command = text.slice(0, cut).trim();
    text = text.slice(cut + 1);
    if (command === 'failure') await search(false);
    if (command === 'fallback') await search(true);
    if (command === 'tasks-on') backgroundRunning = true;
    if (command === 'tasks-off') backgroundRunning = false;
    if (command === 'mode-flip') modeVersion++;
    if (command === 'finish') { processing = false; push({ type: 'complete' }); }
    if (command === 'status') process.stdout.write(JSON.stringify({ cancels, sends, unguardedStops, modeVersion, processing, clients: backend.getConnectedClientCount() }) + '\n');
    if (command === 'exit') { backend.close(); process.exit(0); }
  }
}
backend.close();
