import { describe, expect, it } from 'bun:test';
import { SessionManager } from './SessionManager.ts';

const SID = '261010-loopback-probe';
const TURN = 'msg-original';

function harness() {
  const managed: any = {
    id: SID, isProcessing: true, stopRequested: false, enabledSourceSlugs: [],
    messageQueue: [], backgroundTaskRegistry: new Map(),
    messages: [
      { id: TURN, role: 'user', hidden: false },
      { id: 'tool-1', role: 'tool', toolName: 'WebSearch', toolInput: { query: 'example' }, toolStatus: 'completed' },
    ],
  };
  // No constructor, workspace load, model invocation or actual agent required.
  const manager: any = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[SID, managed]]);
  manager.activeToolUseIds = new Map();
  manager.pendingCredentialResolvers = new Map();
  manager.pendingPermissionRequests = new Map();
  let version = 7;
  manager.getSessionPermissionModeState = () => ({ permissionMode: 'safe', modeVersion: version });
  let stops = 0;
  manager.cancelProcessing = async () => { stops++; managed.stopRequested = true; };
  return { manager, managed, setVersion: (n: number) => { version = n; }, stopped: () => stops };
}

describe('server-side guarded read-only cancellation', () => {
  it('accepts only the original eligible turn and sets stop intent once', async () => {
    const t = harness();
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(true);
    expect(t.stopped()).toBe(1);
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
    expect(t.stopped()).toBe(1);
  });

  it('rejects in-flight tools even before metadata is added to the transcript', async () => {
    const t = harness();
    t.manager.activeToolUseIds.set(SID, new Set(['tool-in-flight']));
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
    expect(t.stopped()).toBe(0);
  });

  it('registers a tool start synchronously before its async metadata lookup', async () => {
    const t = harness();
    t.managed.workspace = { id: 'test-workspace', rootPath: process.cwd() };
    t.managed.workingDirectory = process.cwd();
    t.manager.noteSuggestionUse = () => {};
    t.manager.monotonic = () => Date.now();
    t.manager.getBrowserPaneManagerForSession = () => undefined;
    t.manager.sendEvent = () => {};
    const started = t.manager.processEvent(t.managed, {
      type: 'tool_start', toolName: 'WebSearch', toolUseId: 'pending', input: { query: 'example' },
    });
    expect(t.manager.activeToolUseIds.get(SID)?.has('pending')).toBe(true);
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
    await started;
    expect(t.managed.messages.at(-1).toolStatus).toBe('executing');
  });

  it('rejects incomplete or executing read tools that have not finished', async () => {
    for (const change of [
      (t: ReturnType<typeof harness>) => { t.managed.messages[1].toolInput = {}; },
      (t: ReturnType<typeof harness>) => { t.managed.messages[1].toolStatus = 'executing'; },
    ]) {
      const t = harness(); change(t);
      expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
      expect(t.stopped()).toBe(0);
    }
  });

  it('rejects a mode flip even if the mode name is safe again', async () => {
    const t = harness();
    t.setVersion(8);
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
    expect(t.stopped()).toBe(0);
  });

  it('rejects running background work, queued input, and pending prompts/plans', async () => {
    for (const change of [
      (t: ReturnType<typeof harness>) => t.managed.backgroundTaskRegistry.set('task', { status: 'running' }),
      (t: ReturnType<typeof harness>) => t.managed.messageQueue.push({ message: 'new input' }),
      (t: ReturnType<typeof harness>) => t.manager.pendingPermissionRequests.set('prompt', { sessionId: SID }),
      (t: ReturnType<typeof harness>) => t.manager.pendingCredentialResolvers.set('credential', () => {}),
      (t: ReturnType<typeof harness>) => { t.managed.pendingPlanExecution = { planPath: 'plan' }; },
    ]) {
      const t = harness(); change(t);
      expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
      expect(t.stopped()).toBe(0);
    }
  });

  it('rejects unknown sources, unexpected tools, disguised Bash reads, and a newer user turn', async () => {
    for (const change of [
      (t: ReturnType<typeof harness>) => { t.managed.enabledSourceSlugs = undefined; },
      (t: ReturnType<typeof harness>) => t.managed.enabledSourceSlugs.push('github'),
      (t: ReturnType<typeof harness>) => t.managed.messages.push({ role: 'tool', toolName: 'Bash' }),
      (t: ReturnType<typeof harness>) => { t.managed.messages[1].toolInput = { _command: 'cat file' }; },
      (t: ReturnType<typeof harness>) => t.managed.messages.push({ role: 'user', id: 'steer' }),
    ]) {
      const t = harness(); change(t);
      expect(await t.manager.cancelReadOnlyTurn(SID, TURN, 7)).toBe(false);
      expect(t.stopped()).toBe(0);
    }
  });

  it('rejects a different turn id, unknown session, or invalid version', async () => {
    const t = harness();
    expect(await t.manager.cancelReadOnlyTurn(SID, 'different', 7)).toBe(false);
    expect(await t.manager.cancelReadOnlyTurn('unknown', TURN, 7)).toBe(false);
    expect(await t.manager.cancelReadOnlyTurn(SID, TURN, Number.NaN)).toBe(false);
    expect(t.stopped()).toBe(0);
  });
});
