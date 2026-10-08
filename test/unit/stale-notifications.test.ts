import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, MAX_POLL_INTERVAL_MS } from '../../src/config.js';
import { createVersionGuard, type StatusChange, type VersionGuard } from '../../src/guard.js';
import { MAX_TIMER_MS, nextDelayMs } from '../../src/poller.js';
import type { WasmwardConfigInput } from '../../src/types.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const V2 = hashOf(2);
const POLL = 5_000;
const MAX = 30_000;
const DAY = 86_400_000;

let chain: FakeChain;
const guards: VersionGuard[] = [];

function configWith(overrides: { pollIntervalMs?: number; maxStalenessMs?: number } = {}): WasmwardConfigInput {
  return {
    version: 1,
    network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
    pollIntervalMs: overrides.pollIntervalMs ?? POLL,
    maxStalenessMs: overrides.maxStalenessMs ?? MAX,
    contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] } },
  };
}

async function started(config = configWith()): Promise<{ guard: VersionGuard; changes: (StatusChange & { at: number })[] }> {
  const guard = createVersionGuard(config, { server: chain });
  guards.push(guard);
  const changes: (StatusChange & { at: number })[] = [];
  guard.subscribe((change) => {
    changes.push({ ...change, at: Date.now() });
  });
  await guard.start();
  return { guard, changes };
}

const kinds = (changes: StatusChange[]): string[] => changes.map((change) => `${change.from}>${change.to}`);

beforeEach(() => {
  vi.useFakeTimers();
  // The longest jitter, so that failing polls are as late as they can be and cannot mask the stale timer.
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
});

afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('announcing staleness on time', () => {
  it('tells subscribers the moment a supported contract goes stale, not at the next poll', async () => {
    const { guard, changes } = await started();
    const startedAt = Date.now();
    chain.failLookups = new Error('rpc down');

    // The last good check was at startedAt. At exactly maxStalenessMs it is still fresh.
    await vi.advanceTimersByTimeAsync(MAX);
    expect(guard.isWritable('vault')).toBe(true);
    expect(kinds(changes)).toEqual(['pending>supported']);

    // One millisecond later it is stale, and subscribers are told then. No poll could have noticed:
    // with the longest jitter the failing polls run at about 5.5 s, 16.5 s and 33 s.
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.isWritable('vault')).toBe(false);
    expect(kinds(changes)).toEqual(['pending>supported', 'supported>stale']);
    expect(changes[1]?.at).toBe(startedAt + MAX + 1);
    expect(changes[1]?.state.status).toBe('stale');
  });

  it('announces it once, and the failing polls that follow do not repeat it', async () => {
    const { changes } = await started();
    chain.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(kinds(changes)).toEqual(['pending>supported', 'supported>stale']);
  });

  it('announces the recovery when checks succeed again', async () => {
    const { guard, changes } = await started();
    chain.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(MAX + 1);
    chain.failLookups = undefined;
    await vi.advanceTimersByTimeAsync(MAX);
    expect(kinds(changes)).toEqual(['pending>supported', 'supported>stale', 'stale>supported']);
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('never announces staleness while checks keep succeeding', async () => {
    const { guard, changes } = await started();
    await vi.advanceTimersByTimeAsync(MAX * 20);
    expect(kinds(changes)).toEqual(['pending>supported']);
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('does not announce a stale change for contracts that were never supported', async () => {
    chain.setWasm(VAULT, V2);
    const { changes } = await started();
    chain.failLookups = new Error('rpc down');
    // A poll that fails after the limit moves an unsupported contract to stale, but nothing is
    // announced from the timer: an unsupported contract blocks writes before and after.
    await vi.advanceTimersByTimeAsync(MAX + 100);
    expect(kinds(changes)).toEqual(['pending>unsupported']);
  });

  it('takes a fresh check into account', async () => {
    const { guard, changes } = await started();
    await vi.advanceTimersByTimeAsync(2_000);
    chain.failLookups = undefined;
    await guard.assertWritableFresh('vault'); // refreshes lastSuccessAt at about +2 s
    chain.failLookups = new Error('rpc down');
    const refreshedAt = Date.now();
    await vi.advanceTimersByTimeAsync(MAX);
    expect(kinds(changes)).toEqual(['pending>supported']);
    await vi.advanceTimersByTimeAsync(1);
    expect(kinds(changes)).toEqual(['pending>supported', 'supported>stale']);
    expect(changes[1]?.at).toBe(refreshedAt + MAX + 1);
  });

  it('stops announcing when the guard is stopped, and leaves no timer behind', async () => {
    const { guard, changes } = await started();
    await guard.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(MAX * 3);
    expect(kinds(changes)).toEqual(['pending>supported']);
    // The answers are still right; only the push stops.
    expect(guard.status().vault?.status).toBe('stale');
    expect(guard.isWritable('vault')).toBe(false);
  });

  it('starts announcing again after a restart', async () => {
    const { guard, changes } = await started();
    await guard.stop();
    await guard.start();
    chain.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(MAX + 1);
    expect(kinds(changes).at(-1)).toBe('supported>stale');
  });

  it('keeps one timer for staleness plus the poll timer, nothing more', async () => {
    await started();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL * 10);
    expect(vi.getTimerCount()).toBe(2);
  });

  it('does not hold the process open: its timer is unref’d', async () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      const handle = real(handler, ms);
      return Object.assign(handle, { unref });
    }) as unknown as typeof setTimeout);
    await started();
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('survives a listener that throws when it is announced', async () => {
    const { guard, changes } = await started();
    guard.subscribe(() => {
      throw new Error('listener bug');
    });
    chain.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(MAX + 1);
    expect(kinds(changes).at(-1)).toBe('supported>stale');
    expect(guard.isWritable('vault')).toBe(false);
  });

  it('works with a staleness limit longer than a timer can wait', async () => {
    const config = configWith({ pollIntervalMs: DAY, maxStalenessMs: 40 * DAY });
    const { guard, changes } = await started(config);
    const startedAt = Date.now();
    chain.failLookups = new Error('rpc down');

    await vi.advanceTimersByTimeAsync(40 * DAY);
    expect(guard.isWritable('vault')).toBe(true);
    expect(kinds(changes)).toEqual(['pending>supported']);

    await vi.advanceTimersByTimeAsync(1);
    expect(kinds(changes)).toEqual(['pending>supported', 'supported>stale']);
    expect(changes[1]?.at).toBe(startedAt + 40 * DAY + 1);
  });
});

describe('timer limits', () => {
  it('never returns a poll delay a timer cannot honour', () => {
    expect(nextDelayMs(60, 5_000, Number.MAX_SAFE_INTEGER, () => 0.99)).toBe(MAX_TIMER_MS);
    expect(nextDelayMs(0, DAY, 400 * DAY, () => 0.99)).toBeLessThan(MAX_TIMER_MS);
    for (let failing = 0; failing < 80; failing += 1) {
      expect(nextDelayMs(failing, DAY, 1_000 * DAY, () => 0.99)).toBeLessThanOrEqual(MAX_TIMER_MS);
    }
  });

  it('keeps the exact delay when it is within the limit', () => {
    expect(nextDelayMs(0, 30_000, 120_000, () => 0)).toBe(30_000);
  });

  it('limits the poll interval to one day', () => {
    const input = (pollIntervalMs: number) => ({
      version: 1,
      network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
      pollIntervalMs,
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
    });
    expect(loadConfig(input(MAX_POLL_INTERVAL_MS)).pollIntervalMs).toBe(MAX_POLL_INTERVAL_MS);
    expect(() => loadConfig(input(MAX_POLL_INTERVAL_MS + 1))).toThrow(/must be at most 86400000 \(one day\)/);
    try {
      loadConfig(input(30 * DAY));
    } catch (error) {
      expect((error as { issues: { path: string }[] }).issues.map((issue) => issue.path)).toContain('$.pollIntervalMs');
    }
  });
});
