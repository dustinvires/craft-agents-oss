import { describe, expect, it } from 'bun:test';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { HandlerFn, RpcServer, RequestContext } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { registerSessionsHandlers } from './sessions';

function harness(backgroundAvailable = true, guardedAvailable = true) {
  const handlers = new Map<string, HandlerFn>();
  const server = { handle(channel: string, fn: HandlerFn) { handlers.set(channel, fn); } } as RpcServer;
  const calls: string[] = [];
  const manager = {
    getSessionPermissionModeState(id: string) {
      calls.push(`mode:${id}`);
      return { permissionMode: 'safe', modeVersion: 42 };
    },
    ...(backgroundAvailable ? { listBackgroundTasks(id: string) {
      calls.push(`tasks:${id}`);
      return [{ taskId: 'ongoing', status: 'running' }];
    } } : {}),
    ...(guardedAvailable ? { async cancelReadOnlyTurn(id: string, turn: string, version: number) {
      calls.push(`stop:${id}:${turn}:${version}`);
      return version === 42;
    } } : {}),
  };
  const deps = {
    sessionManager: manager,
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  } as unknown as HandlerDeps;
  registerSessionsHandlers(server, deps);
  const ctx = { clientId: 'test', workspaceId: 'ws' } as RequestContext;
  return { handlers, ctx, calls };
}

describe('read-only turn recovery RPC facts', () => {
  it('returns live mode version and background task status instead of header guesses', async () => {
    const { handlers, ctx, calls } = harness();
    const mode = handlers.get(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE)!;
    const tasks = handlers.get(RPC_CHANNELS.sessions.LIST_BACKGROUND_TASKS)!;
    expect(await mode(ctx, '261010-test-turn')).toEqual({ permissionMode: 'safe', modeVersion: 42 });
    expect(await tasks(ctx, '261010-test-turn')).toEqual([{ taskId: 'ongoing', status: 'running' }]);
    expect(calls).toEqual(['mode:261010-test-turn', 'tasks:261010-test-turn']);
  });

  it('routes conditional stop and refuses missing guarded manager support', async () => {
    const { handlers, ctx, calls } = harness();
    const stop = handlers.get(RPC_CHANNELS.sessions.CANCEL_READ_ONLY_TURN)!;
    expect(await stop(ctx, '261010-test-turn', 'msg-1', 42)).toBe(true);
    expect(await stop(ctx, '261010-test-turn', 'msg-1', 41)).toBe(false);
    expect(calls).toEqual(['stop:261010-test-turn:msg-1:42', 'stop:261010-test-turn:msg-1:41']);
    const absent = harness(true, false);
    await expect(absent.handlers.get(RPC_CHANNELS.sessions.CANCEL_READ_ONLY_TURN)!(absent.ctx, 'id', 'msg', 42))
      .rejects.toThrow('Guarded cancellation unavailable');
  });

  it('rejects missing background registry rather than claiming no tasks exist', async () => {
    const { handlers, ctx } = harness(false);
    await expect(handlers.get(RPC_CHANNELS.sessions.LIST_BACKGROUND_TASKS)!(ctx, '261010-test-turn'))
      .rejects.toThrow('Background task registry unavailable');
  });
});
