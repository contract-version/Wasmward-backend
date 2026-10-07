import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, WriteBlockedError } from '../../src/errors.js';
import { createVersionGuard, type StatusChange, type VersionGuard } from '../../src/guard.js';
import type { WasmwardConfig } from '../../src/types.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const POLL = 30_000;
const MAX = 120_000;
/** Long enough for any single jittered poll wait, at most 1.1 intervals. */
const ONE_POLL = POLL * 1.1;

const VAULT = contractIdOf(1);
const POOL = contractIdOf(2);
const V1 = hashOf(1);
const V2 = hashOf(2);

function configWith(vaultHashes: string[] = [V1], overrides: Partial<WasmwardConfig> = {}): WasmwardConfig {
  return {
    version: 1,
    network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
    pollIntervalMs: POLL,
    maxStalenessMs: MAX,
    contracts: {
      vault: { contractId: VAULT, supported: vaultHashes.map((wasmHash, i) => ({ wasmHash, label: `v${i + 1}` })) },
    },
    ...overrides,
  };
}

let chain: FakeChain;
const guards: VersionGuard[] = [];

function make(config: WasmwardConfig = configWith()): VersionGuard {
  const guard = createVersionGuard(config, { server: chain });
  guards.push(guard);
  return guard;
}

async function started(config?: WasmwardConfig): Promise<VersionGuard> {
  const guard = make(config);
  await guard.start();
  return guard;
}

/** Records every change delivered to a new subscriber. */
function listen(guard: VersionGuard): StatusChange[] {
  const changes: StatusChange[] = [];
  guard.subscribe((change) => {
    changes.push(change);
  });
  return changes;
}

beforeEach(() => {
  vi.useFakeTimers();
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
});

afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.stop();
  vi.useRealTimers();
});

describe('start', () => {
  it('verifies the network, then runs the first check', async () => {
    const guard = make();
    expect(guard.status()['vault']?.status).toBe('pending');
    await guard.start();
    expect(chain.networkCalls).toBe(1);
    expect(chain.lookupCalls).toEqual([1]);
    expect(guard.status()['vault']?.status).toBe('supported');
  });

  it('throws ConfigError on a network passphrase mismatch and never starts polling', async () => {
    chain.passphrase = 'Public Global Stellar Network ; September 2015';
    const guard = make();
    const error = await guard.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('Public Global Stellar Network');
    expect(chain.lookupCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL * 10);
    expect(chain.lookupCalls).toEqual([]);
    expect(guard.isWritable('vault')).toBe(false);
    expect(guard.health().ok).toBe(false);
    expect(guard.health().network.verified).toBe(false);
  });

  it('fails when the network cannot be verified and does not start polling', async () => {
    chain.failNetwork = new Error('connection refused');
    const guard = make();
    await expect(guard.start()).rejects.toThrow(/Could not verify the network: connection refused/);
    expect(chain.lookupCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can be retried after a failed network check', async () => {
    chain.failNetwork = new Error('offline');
    const guard = make();
    await expect(guard.start()).rejects.toThrow();
    chain.failNetwork = undefined;
    await guard.start();
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('verifies the network once when started twice', async () => {
    const guard = make();
    await Promise.all([guard.start(), guard.start()]);
    await guard.start();
    expect(chain.networkCalls).toBe(1);
    expect(chain.lookupCalls).toEqual([1]);
  });

  it('does not start polling when stop() arrives during network verification', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = {
      getNetwork: async () => {
        await gate;
        return { passphrase: PASSPHRASE };
      },
      getLedgerEntries: chain.getLedgerEntries,
    };
    const guard = createVersionGuard(configWith(), { server });
    guards.push(guard);
    const starting = guard.start();
    const stopping = guard.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(chain.lookupCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await guard.start();
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('rejects an invalid config object', () => {
    const bad = { ...configWith(), version: 2 } as unknown as WasmwardConfig;
    expect(() => createVersionGuard(bad, { server: chain })).toThrow(ConfigError);
  });

  it('builds its own RPC client when none is given', async () => {
    const config = configWith([V1], { network: { rpcUrl: 'http://127.0.0.1:1', passphrase: PASSPHRASE } });
    const guard = createVersionGuard(config);
    await expect(guard.start()).rejects.toThrow(/Could not verify the network/);
    const secure = createVersionGuard(configWith());
    expect(secure.isWritable('vault')).toBe(false);
  });
});

describe('upgrade and recovery', () => {
  it('moves to unsupported within one poll interval of an upgrade, and assertWritable throws', async () => {
    const guard = await started();
    expect(() => guard.assertWritable('vault')).not.toThrow();

    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);

    expect(guard.status()['vault']).toMatchObject({ status: 'unsupported', liveWasmHash: V2 });
    expect(guard.isWritable('vault')).toBe(false);
    const error = (() => {
      try {
        guard.assertWritable('vault');
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(WriteBlockedError);
    const blocked = error as WriteBlockedError;
    expect(blocked.contract).toBe('vault');
    expect(blocked.status).toBe('unsupported');
    expect(blocked.liveWasmHash).toBe(V2);
    expect(blocked.reason).toBe(`live code ${V2} is not in the supported list`);
    expect(blocked.message).toBe(`Writes to 'vault' are blocked: live code ${V2} is not in the supported list`);
  });

  it('returns to supported once a guard is created with the new hash in its config', async () => {
    const first = await started();
    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(first.isWritable('vault')).toBe(false);
    await first.stop();

    const second = await started(configWith([V1, V2]));
    expect(second.isWritable('vault')).toBe(true);
    expect(second.status()['vault']).toMatchObject({ status: 'supported', matchedLabel: 'v2' });
  });

  it('keeps writes blocked for a contract that does not exist', async () => {
    chain.remove(VAULT);
    const guard = await started();
    expect(guard.status()['vault']?.status).toBe('missing');
    expect(() => guard.assertWritable('vault')).toThrow(/no contract instance was found/);
  });

  it('blocks a Stellar Asset Contract', async () => {
    chain.setAsset(VAULT);
    const guard = await started();
    expect(guard.status()['vault']?.status).toBe('stellar-asset');
    expect(() => guard.assertWritable('vault')).toThrow(/Stellar Asset Contract/);
  });

  it('blocks an archived contract', async () => {
    chain.ttl = -1;
    const guard = await started();
    expect(guard.status()['vault']?.status).toBe('archived');
    expect(() => guard.assertWritable('vault')).toThrow(/expired \(archived\)/);
  });

  it('checks every contract in one lookup per tick', async () => {
    chain.setWasm(POOL, V1);
    const config = configWith();
    config.contracts['pool'] = { contractId: POOL, supported: [{ wasmHash: V1 }] };
    const guard = await started(config);
    expect(chain.lookupCalls).toEqual([2]);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(chain.lookupCalls).toEqual([2, 2]);
    expect(guard.isWritable('vault') && guard.isWritable('pool')).toBe(true);
  });

  it('tracks contracts independently', async () => {
    chain.setWasm(POOL, V2);
    const config = configWith();
    config.contracts['pool'] = { contractId: POOL, supported: [{ wasmHash: V1 }] };
    const guard = await started(config);
    expect(guard.isWritable('vault')).toBe(true);
    expect(guard.isWritable('pool')).toBe(false);
    expect(guard.health().ok).toBe(false);
  });
});

describe('failures never produce supported', () => {
  it('stays pending and blocked while every lookup fails', async () => {
    chain.failLookups = new Error('rpc down');
    const guard = await started();
    expect(guard.status()['vault']).toMatchObject({ status: 'pending', consecutiveErrors: 1, lastError: 'rpc down' });
    expect(guard.isWritable('vault')).toBe(false);
    expect(() => guard.assertWritable('vault')).toThrow(/no successful check of the live code has completed yet; last error: rpc down/);
    await vi.advanceTimersByTimeAsync(MAX * 3);
    expect(guard.status()['vault']?.status).toBe('pending');
    expect(guard.isWritable('vault')).toBe(false);
  });

  it('allows writes within the staleness limit after a failure, then blocks and reports stale', async () => {
    const guard = await started();
    const changes = listen(guard);
    chain.failLookups = new Error('timeout');
    // Failing ticks run at +60s (2x backoff, capped) and +120s: still inside the limit.
    await vi.advanceTimersByTimeAsync(POLL * 2.2);
    expect(guard.status()['vault']).toMatchObject({ status: 'supported', consecutiveErrors: 1 });
    expect(guard.isWritable('vault')).toBe(true);

    await vi.advanceTimersByTimeAsync(MAX);
    expect(guard.status()['vault']?.status).toBe('stale');
    expect(guard.isWritable('vault')).toBe(false);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['supported>stale']);
    expect(() => guard.assertWritable('vault')).toThrow(/last successful check was \d+s ago.*last error: timeout/);
  });

  it('recovers to supported when the RPC comes back', async () => {
    const guard = await started();
    chain.failLookups = new Error('timeout');
    await vi.advanceTimersByTimeAsync(MAX * 3);
    expect(guard.isWritable('vault')).toBe(false);
    chain.failLookups = undefined;
    await vi.advanceTimersByTimeAsync(MAX);
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('blocks writes once a stopped poller leaves the last success too old', async () => {
    const guard = await started();
    await guard.stop();
    expect(guard.isWritable('vault')).toBe(true);
    await vi.advanceTimersByTimeAsync(MAX);
    expect(guard.isWritable('vault')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.status()['vault']?.status).toBe('stale');
    expect(guard.isWritable('vault')).toBe(false);
    expect(() => guard.assertWritable('vault')).toThrow(WriteBlockedError);
    expect(guard.health().ok).toBe(false);
    expect(guard.health().contracts['vault']).toMatchObject({ status: 'stale', writable: false });
  });

  it('uses the injected clock', async () => {
    let clock = 5_000_000;
    const guard = createVersionGuard(configWith(), { server: chain, now: () => clock });
    guards.push(guard);
    await guard.start();
    expect(guard.status()['vault']).toMatchObject({ lastSuccessAt: 5_000_000, lastCheckedAt: 5_000_000 });
    clock += MAX;
    expect(guard.isWritable('vault')).toBe(true);
    clock += 1;
    expect(guard.isWritable('vault')).toBe(false);
    expect(guard.health().checkedAt).toBe(clock);
  });
});

describe('subscribe', () => {
  it('fires once per status transition, not on every tick', async () => {
    const guard = make();
    const changes = listen(guard);
    await guard.start();
    await vi.advanceTimersByTimeAsync(ONE_POLL * 3);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['pending>supported']);

    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL * 3);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['pending>supported', 'supported>unsupported']);

    chain.setWasm(VAULT, V1);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual([
      'pending>supported',
      'supported>unsupported',
      'unsupported>supported',
    ]);
  });

  it('describes the change with the contract name and its new state', async () => {
    const guard = make();
    const changes = listen(guard);
    await guard.start();
    expect(changes).toHaveLength(1);
    const change = changes[0] as StatusChange;
    expect(change.name).toBe('vault');
    expect(change.from).toBe('pending');
    expect(change.to).toBe('supported');
    expect(change.state).toMatchObject({ name: 'vault', status: 'supported', liveWasmHash: V1, matchedLabel: 'v1' });
  });

  it('does not fire while a contract stays pending', async () => {
    chain.failLookups = new Error('down');
    const guard = make();
    const changes = listen(guard);
    await guard.start();
    await vi.advanceTimersByTimeAsync(MAX * 2);
    expect(changes).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const guard = make();
    const listener = vi.fn();
    const unsubscribe = guard.subscribe(listener);
    await guard.start();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps polling and keeps notifying others when a listener throws or rejects', async () => {
    const guard = make();
    const healthy = vi.fn();
    guard.subscribe(() => {
      throw new Error('sync listener bug');
    });
    guard.subscribe(() => Promise.reject(new Error('async listener bug')));
    guard.subscribe(healthy);
    await guard.start();
    expect(healthy).toHaveBeenCalledTimes(1);

    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(guard.status()['vault']?.status).toBe('unsupported');
  });

  it('hands each listener its own copy of the state', async () => {
    const guard = make();
    const seen: StatusChange[] = [];
    guard.subscribe((change) => {
      change.state.status = 'supported';
      change.state.liveWasmHash = 'tampered';
    });
    guard.subscribe((change) => {
      seen.push(change);
    });
    await guard.start();
    expect(seen[0]?.state.liveWasmHash).toBe(V1);
    expect(guard.status()['vault']?.liveWasmHash).toBe(V1);
  });
});

describe('unknown contract names', () => {
  it.each(['nope', 'constructor', 'toString', '__proto__', ''])('throws ConfigError for %j in every method', async (name) => {
    const guard = await started();
    expect(() => guard.isWritable(name)).toThrow(ConfigError);
    expect(() => guard.assertWritable(name)).toThrow(ConfigError);
    expect(() => guard.guard(name, async () => 1)).toThrow(ConfigError);
    await expect(guard.assertWritableFresh(name)).rejects.toBeInstanceOf(ConfigError);
  });

  it('lists the configured names in the message', async () => {
    const guard = await started();
    expect(() => guard.isWritable('vualt')).toThrow(/Unknown contract 'vualt'.*vault/);
  });
});

describe('guard wrapper', () => {
  it('passes arguments and return values through when writable', async () => {
    const guard = await started();
    const deposit = vi.fn(async (amount: number, memo: string) => ({ amount, memo }));
    const safe = guard.guard('vault', deposit);
    await expect(safe(5, 'hi')).resolves.toEqual({ amount: 5, memo: 'hi' });
    expect(deposit).toHaveBeenCalledWith(5, 'hi');
  });

  it('passes errors from the wrapped function through unchanged', async () => {
    const guard = await started();
    const failure = new Error('insufficient balance');
    const safe = guard.guard('vault', async () => {
      throw failure;
    });
    await expect(safe()).rejects.toBe(failure);
  });

  it('wraps synchronous functions too', async () => {
    const guard = await started();
    const safe = guard.guard('vault', (a: number, b: number) => a + b);
    await expect(safe(2, 3)).resolves.toBe(5);
  });

  it('blocks without calling the function when the contract is not writable', async () => {
    const guard = await started();
    const deposit = vi.fn(async () => 'sent');
    const safe = guard.guard('vault', deposit);
    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    await expect(safe()).rejects.toBeInstanceOf(WriteBlockedError);
    expect(deposit).not.toHaveBeenCalled();
  });

  it('checks before every call, not once', async () => {
    const guard = await started();
    const safe = guard.guard('vault', async () => 'sent');
    await expect(safe()).resolves.toBe('sent');
    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    await expect(safe()).rejects.toBeInstanceOf(WriteBlockedError);
    chain.setWasm(VAULT, V1);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    await expect(safe()).resolves.toBe('sent');
  });

  it('blocks before the guard has been started', async () => {
    const guard = make();
    const write = vi.fn(async () => 1);
    await expect(guard.guard('vault', write)()).rejects.toThrow(/not been started/);
    expect(write).not.toHaveBeenCalled();
  });

  it('works when the method is detached from the guard object', async () => {
    const guard = await started();
    const { guard: wrap } = guard;
    await expect(wrap('vault', async () => 'ok', { fresh: true })()).resolves.toBe('ok');
  });

  it('does a fresh lookup before each call with fresh: true', async () => {
    const guard = await started();
    const write = vi.fn(async () => 'sent');
    const safe = guard.guard('vault', write, { fresh: true });
    chain.lookupCalls.length = 0;
    await safe();
    await safe();
    expect(chain.lookupCalls).toEqual([1, 1]);
  });

  it('blocks a fresh wrapper the moment the contract is upgraded, before the next poll', async () => {
    const guard = await started();
    const write = vi.fn(async () => 'sent');
    const safe = guard.guard('vault', write, { fresh: true });
    chain.setWasm(VAULT, V2);
    await expect(safe()).rejects.toBeInstanceOf(WriteBlockedError);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('assertWritableFresh', () => {
  it('performs exactly one lookup', async () => {
    const guard = await started();
    chain.lookupCalls.length = 0;
    await guard.assertWritableFresh('vault');
    expect(chain.lookupCalls).toEqual([1]);
  });

  it('looks up only the named contract', async () => {
    chain.setWasm(POOL, V1);
    const config = configWith();
    config.contracts['pool'] = { contractId: POOL, supported: [{ wasmHash: V1 }] };
    const guard = await started(config);
    chain.lookupCalls.length = 0;
    await guard.assertWritableFresh('pool');
    expect(chain.lookupCalls).toEqual([1]);
  });

  it('sees an upgrade before the poller does, blocks, and tells subscribers', async () => {
    const guard = await started();
    const changes = listen(guard);
    chain.setWasm(VAULT, V2);
    const error = await guard.assertWritableFresh('vault').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WriteBlockedError);
    expect((error as WriteBlockedError).status).toBe('unsupported');
    expect(guard.status()['vault']?.status).toBe('unsupported');
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['supported>unsupported']);
  });

  it('blocks when the fresh lookup fails, even though the stored state is still fresh and supported', async () => {
    const guard = await started();
    chain.failLookups = new Error('rpc timeout');
    const error = await guard.assertWritableFresh('vault').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WriteBlockedError);
    expect((error as WriteBlockedError).reason).toBe('the live code could not be checked just now (rpc timeout)');
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('recovers a stale contract on a good fresh lookup', async () => {
    const guard = await started();
    chain.failLookups = new Error('down');
    await vi.advanceTimersByTimeAsync(MAX * 3);
    expect(guard.isWritable('vault')).toBe(false);
    chain.failLookups = undefined;
    await expect(guard.assertWritableFresh('vault')).resolves.toBeUndefined();
    expect(guard.isWritable('vault')).toBe(true);
  });

  it('refuses before the guard has been started, without a lookup', async () => {
    const guard = make();
    await expect(guard.assertWritableFresh('vault')).rejects.toThrow(/has not been started/);
    expect(chain.lookupCalls).toEqual([]);
  });

  it('does not let a slow, older lookup overwrite a newer result', async () => {
    const guard = await started();
    let release: () => void = () => undefined;
    chain.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next poll starts while the chain still reports v1, then hangs on the gate.
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    // The contract is upgraded, and a fresh check (which also hangs) is not what we want here:
    // open the gate for later calls only by clearing it before the fresh lookup starts.
    chain.setWasm(VAULT, V2);
    const slowGate = chain.gate;
    chain.gate = undefined;
    await expect(guard.assertWritableFresh('vault')).rejects.toBeInstanceOf(WriteBlockedError);
    expect(guard.status()['vault']?.status).toBe('unsupported');
    // The old poll now finishes with its stale v1 answer. It must be ignored.
    chain.gate = slowGate;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.status()['vault']).toMatchObject({ status: 'unsupported', liveWasmHash: V2 });
    expect(guard.isWritable('vault')).toBe(false);
  });
});

describe('status and health', () => {
  it('returns copies that cannot change the guard', async () => {
    const guard = await started();
    const snapshot = guard.status();
    const vault = snapshot['vault'];
    if (vault === undefined) throw new Error('missing vault');
    vault.status = 'pending';
    vault.liveWasmHash = 'tampered';
    expect(guard.status()['vault']).toMatchObject({ status: 'supported', liveWasmHash: V1 });
  });

  it('reports the full state of every contract', async () => {
    const guard = await started();
    expect(guard.status()['vault']).toEqual({
      name: 'vault',
      contractId: VAULT,
      status: 'supported',
      liveWasmHash: V1,
      matchedLabel: 'v1',
      lastCheckedAt: expect.any(Number),
      lastSuccessAt: expect.any(Number),
      consecutiveErrors: 0,
    });
  });

  it('produces a plain JSON health report', async () => {
    const guard = await started();
    const report = guard.health();
    expect(report).toEqual({
      ok: true,
      network: { passphrase: PASSPHRASE, verified: true },
      contracts: {
        vault: {
          contractId: VAULT,
          status: 'supported',
          writable: true,
          liveWasmHash: V1,
          matchedLabel: 'v1',
          lastCheckedAt: expect.any(Number),
          lastSuccessAt: expect.any(Number),
          consecutiveErrors: 0,
        },
      },
      checkedAt: expect.any(Number),
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('is not ok when any contract is not supported', async () => {
    chain.setWasm(POOL, V2);
    const config = configWith();
    config.contracts['pool'] = { contractId: POOL, supported: [{ wasmHash: V1 }] };
    const guard = await started(config);
    const report = guard.health();
    expect(report.ok).toBe(false);
    expect(report.contracts['vault']?.writable).toBe(true);
    expect(report.contracts['pool']).toMatchObject({ status: 'unsupported', writable: false });
  });

  it('is not ok before the first check', () => {
    const guard = make();
    const report = guard.health();
    expect(report.ok).toBe(false);
    expect(report.contracts['vault']).toMatchObject({ status: 'pending', writable: false });
    expect(report.contracts['vault']).not.toHaveProperty('liveWasmHash');
  });

  it('includes the last error and omits the RPC URL', async () => {
    chain.failLookups = new Error('rpc down');
    const guard = await started();
    const report = guard.health();
    expect(report.contracts['vault']).toMatchObject({ lastError: 'rpc down', consecutiveErrors: 1 });
    expect(JSON.stringify(report)).not.toContain('rpc.example.org');
  });
});

describe('stop', () => {
  it('stops polling', async () => {
    const guard = await started();
    await guard.stop();
    const calls = chain.lookupCalls.length;
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(chain.lookupCalls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can start again after stopping without re-verifying the network', async () => {
    const guard = await started();
    await guard.stop();
    await guard.start();
    expect(chain.networkCalls).toBe(1);
    expect(guard.isWritable('vault')).toBe(true);
  });
});
