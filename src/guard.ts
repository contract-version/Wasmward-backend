import { loadConfig } from './config.js';
import { ConfigError, WriteBlockedError } from './errors.js';
import { createEndpointSet, createRpcClient, type GuardServer } from './endpoints.js';
import { buildHealth, type HealthReport } from './health.js';
import { createPoller, MAX_TIMER_MS } from './poller.js';
import {
  describeBlock,
  describeTimeLeft,
  effectiveStatus,
  expiringEntry,
  initialState,
  isWritable,
  ledgersUntilExpiry,
  nextState,
} from './state.js';
import type { ContractConfig, ContractState, LiveExecutable, Status, WasmwardConfigInput } from './types.js';

/** A single lookup waits at most this long, and never longer than one poll interval. */
const MAX_LOOKUP_TIMEOUT_MS = 10_000;

export type { GuardServer };

export interface VersionGuardOptions {
  /** RPC client to use. Defaults to `new rpc.Server(config.network.rpcUrl)`. */
  server?: GuardServer;
  /** RPC clients to fall back to, in order. Defaults to one client per `network.fallbackRpcUrls` entry. */
  fallbackServers?: GuardServer[];
  /** Clock in milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Custom per-lookup RPC timeout in milliseconds, clamped to `[1, pollIntervalMs]`. */
  lookupTimeoutMs?: number;
  /** Uniform `[0, 1)` random source for poll jitter. Defaults to `Math.random`. */
  random?: () => number;
}

export interface AssertWritableOptions {
  /** Also block writes if the contract's remaining TTL (instance or Wasm code) is below this many ledgers. */
  minTtlLedgers?: number | undefined;
}

/** Delivered to subscribers when a contract's status changes. */
export interface StatusChange {
  name: string;
  from: Status;
  to: Status;
  state: ContractState;
}

export type StatusListener = (change: StatusChange) => void | Promise<void>;

export interface VersionGuard {
  /** Confirms the RPC serves the configured network, runs one check, then keeps checking. */
  start(): Promise<void>;
  /** Stops checking and waits for a check in progress to finish. */
  stop(): Promise<void>;
  /** Every contract's state as of now, with staleness applied to `status`. */
  status(): Record<string, ContractState>;
  isWritable(name: string): boolean;
  /** Throws {@link WriteBlockedError} unless the contract is supported and freshly verified. */
  assertWritable(name: string, options?: AssertWritableOptions): void;
  /** Looks the contract up once more, then asserts. Blocks if that lookup fails. */
  assertWritableFresh(name: string, options?: AssertWritableOptions): Promise<void>;
  /** Calls `listener` whenever a contract's status changes. Returns an unsubscribe function. */
  subscribe(listener: StatusListener): () => void;
  /** Wraps a write function so each call first asserts that the contract is writable. */
  guard<A extends unknown[], R>(
    name: string,
    write: (...args: A) => R | Promise<R>,
    options?: { fresh?: boolean; minTtlLedgers?: number },
  ): (...args: A) => Promise<Awaited<R>>;
  health(): HealthReport;
}

function validateMinTtlLedgers(minTtlLedgers: number | undefined): void {
  if (minTtlLedgers === undefined) return;
  if (!Number.isInteger(minTtlLedgers) || minTtlLedgers < 1) {
    throw new ConfigError(`minTtlLedgers must be a positive integer, got ${String(minTtlLedgers)}.`);
  }
}

export function createVersionGuard(input: WasmwardConfigInput, options: VersionGuardOptions = {}): VersionGuard {
  // Validate again so a hand-built or edited object can never bypass the schema rules.
  const config = loadConfig(input);
  const now = options.now ?? Date.now;
  const { maxStalenessMs } = config;
  if (
    options.lookupTimeoutMs !== undefined &&
    (!Number.isInteger(options.lookupTimeoutMs) || options.lookupTimeoutMs < 1)
  ) {
    throw new ConfigError(`lookupTimeoutMs must be a positive integer, got ${String(options.lookupTimeoutMs)}.`);
  }
  const lookupTimeoutMs =
    options.lookupTimeoutMs !== undefined
      ? Math.min(options.lookupTimeoutMs, config.pollIntervalMs)
      : Math.min(config.pollIntervalMs, MAX_LOOKUP_TIMEOUT_MS);
  const endpoints = createEndpointSet(
    [
      options.server ?? createRpcClient(config.network.rpcUrl, lookupTimeoutMs),
      ...(options.fallbackServers ?? config.network.fallbackRpcUrls.map((url) => createRpcClient(url, lookupTimeoutMs))),
    ],
    config.network.passphrase,
    lookupTimeoutMs,
  );

  // A Map, not the config object, so names like "constructor" are never found by inheritance.
  const contracts = new Map<string, ContractConfig>(Object.entries(config.contracts));
  const states = new Map<string, ContractState>();
  /** The status subscribers were last told about, so a change is reported once. */
  const reported = new Map<string, Status>();
  /** Start time of the newest lookup applied, so a slow older lookup cannot overwrite newer data. */
  const appliedStart = new Map<string, number>();
  const listeners = new Set<StatusListener>();
  let networkVerified = false;
  /** The start in progress or completed, so concurrent calls share one network check. */
  let starting: Promise<void> | undefined;
  /** Bumped by stop(), so a start that was still verifying the network can tell it was cancelled. */
  let stopEpoch = 0;

  for (const [name, contract] of contracts) {
    states.set(name, initialState(name, contract));
    reported.set(name, 'pending');
  }

  function contractFor(name: string): ContractConfig {
    const contract = contracts.get(name);
    if (contract === undefined) {
      throw new ConfigError(`Unknown contract '${name}'. Configured contracts: ${[...contracts.keys()].join(', ')}.`);
    }
    return contract;
  }

  function stateFor(name: string): ContractState {
    contractFor(name);
    const state = states.get(name);
    if (state === undefined) throw new ConfigError(`No state for contract '${name}'.`);
    return state;
  }

  function snapshot(state: ContractState): ContractState {
    return { ...state, status: effectiveStatus(state, now(), maxStalenessMs) };
  }

  /** Applies one lookup result, unless a lookup that started later has already been applied. */
  function apply(name: string, result: LiveExecutable, startedAt: number): void {
    const newest = appliedStart.get(name);
    if (newest !== undefined && startedAt < newest) return;
    appliedStart.set(name, startedAt);
    // Fresh data is dated from when its lookup began, the conservative choice. An error is judged
    // against the current time so staleness is noticed as soon as it is real.
    const at = result.kind === 'error' ? now() : startedAt;
    states.set(name, nextState(stateFor(name), result, contractFor(name), at, maxStalenessMs));
  }

  function collectChanges(names: Iterable<string>): StatusChange[] {
    const changes: StatusChange[] = [];
    for (const name of names) {
      const state = stateFor(name);
      const to = effectiveStatus(state, now(), maxStalenessMs);
      const from = reported.get(name) ?? 'pending';
      if (to === from) continue;
      reported.set(name, to);
      changes.push({ name, from, to, state: { ...state, status: to } });
    }
    return changes;
  }

  function emit(changes: StatusChange[]): void {
    for (const change of changes) {
      for (const listener of [...listeners]) {
        try {
          // A listener that throws or rejects must never stop the poller or other listeners.
          void Promise.resolve(listener({ ...change, state: { ...change.state } })).catch(() => undefined);
        } catch {
          // Ignored for the same reason.
        }
      }
    }
  }

  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  /** True from a successful start until stop(). Only then are time-driven notifications sent. */
  let notifying = false;

  function clearStaleTimer(): void {
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    staleTimer = undefined;
  }

  /**
   * A supported contract turns stale just by time passing, with no check needed to notice. Arm one timer
   * for the soonest moment that happens, so subscribers hear about it on time instead of at the next poll.
   */
  function scheduleStaleCheck(): void {
    clearStaleTimer();
    if (!notifying) return;
    const at = now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const state of states.values()) {
      // Only a contract that is still fresh can go stale later. One that already has was announced by
      // publish(), and waiting on it again would arm a zero-length timer over and over.
      if (state.lastSuccessAt === undefined || effectiveStatus(state, at, maxStalenessMs) !== 'supported') continue;
      // A contract is stale once its last success is more than maxStalenessMs old.
      soonest = Math.min(soonest, state.lastSuccessAt + maxStalenessMs + 1 - at);
    }
    if (!Number.isFinite(soonest)) return;
    staleTimer = setTimeout(() => {
      staleTimer = undefined;
      publish(contracts.keys());
    }, Math.min(Math.max(soonest, 1), MAX_TIMER_MS));
    // Never keep a process alive just to announce a status change.
    if (typeof staleTimer === 'object' && typeof staleTimer.unref === 'function') staleTimer.unref();
  }

  /** Tells subscribers about any status changes, then arms the timer for the next one. */
  function publish(names: Iterable<string>): void {
    emit(collectChanges(names));
    scheduleStaleCheck();
  }

  async function tick(): Promise<boolean> {
    const startedAt = now();
    const ids = [...contracts.values()].map((contract) => contract.contractId);
    const results = await endpoints.lookup(ids, lookupTimeoutMs);
    let everyLookupFailed = true;
    for (const [name, contract] of contracts) {
      const result = results.get(contract.contractId) ?? { kind: 'error' as const, message: 'no result returned' };
      if (result.kind !== 'error') everyLookupFailed = false;
      apply(name, result, startedAt);
    }
    publish(contracts.keys());
    return everyLookupFailed;
  }

  const poller = createPoller({
    intervalMs: config.pollIntervalMs,
    maxStalenessMs,
    tick,
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  function blocked(name: string, reason?: string): WriteBlockedError {
    const state = stateFor(name);
    const at = now();
    return new WriteBlockedError({
      contract: name,
      status: effectiveStatus(state, at, maxStalenessMs),
      liveWasmHash: state.liveWasmHash,
      reason: reason ?? describeBlock(state, at, maxStalenessMs),
    });
  }

  function assertWritable(name: string, assertOptions?: AssertWritableOptions): void {
    const state = stateFor(name);
    validateMinTtlLedgers(assertOptions?.minTtlLedgers);
    if (!networkVerified) throw blocked(name, 'the guard has not been started, so the network is not verified');
    if (!isWritable(state, now(), maxStalenessMs)) throw blocked(name);
    if (assertOptions?.minTtlLedgers !== undefined) {
      const remaining = ledgersUntilExpiry(state);
      if (remaining !== undefined && remaining < assertOptions.minTtlLedgers) {
        const which = expiringEntry(state) === 'code' ? 'Wasm code' : 'instance';
        throw blocked(
          name,
          `${which} expires in ${remaining} ledgers (${describeTimeLeft(remaining)}), below the required minimum of ${assertOptions.minTtlLedgers} ledgers`,
        );
      }
    }
  }

  async function assertWritableFresh(name: string, assertOptions?: AssertWritableOptions): Promise<void> {
    const contract = contractFor(name);
    validateMinTtlLedgers(assertOptions?.minTtlLedgers);
    if (!networkVerified) throw blocked(name, 'the guard has not been started, so the network is not verified');
    const startedAt = now();
    const result =
      (await endpoints.lookup([contract.contractId], lookupTimeoutMs)).get(contract.contractId) ??
      ({ kind: 'error', message: 'no result returned' } as const);
    apply(name, result, startedAt);
    publish([name]);
    if (result.kind === 'error') {
      throw blocked(name, `the live code could not be checked just now (${result.message})`);
    }
    assertWritable(name, assertOptions);
  }


  return {
    start(): Promise<void> {
      if (starting !== undefined) return starting;
      const epoch = stopEpoch;
      const attempt = (async (): Promise<void> => {
        if (!networkVerified) {
          // Throws ConfigError when the primary serves another network, or Error when nothing answers.
          await endpoints.verifyNetwork();
          networkVerified = true;
        }
        // A stop() that arrived while the network was being checked cancels this start.
        if (epoch !== stopEpoch) return;
        notifying = true;
        await poller.start();
      })();
      starting = attempt;
      // A failed start must not stick: the caller can try again.
      attempt.catch(() => {
        if (starting === attempt) starting = undefined;
      });
      return attempt;
    },

    stop(): Promise<void> {
      stopEpoch += 1;
      notifying = false;
      clearStaleTimer();
      starting = undefined;
      return poller.stop();
    },

    status(): Record<string, ContractState> {
      const out: Record<string, ContractState> = {};
      for (const [name, state] of states) out[name] = snapshot(state);
      return out;
    },

    isWritable(name: string): boolean {
      const state = stateFor(name);
      return networkVerified && isWritable(state, now(), maxStalenessMs);
    },

    assertWritable,

    assertWritableFresh,

    subscribe(listener: StatusListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    guard<A extends unknown[], R>(
      name: string,
      write: (...args: A) => R | Promise<R>,
      guardOptions: { fresh?: boolean; minTtlLedgers?: number } = {},
    ): (...args: A) => Promise<Awaited<R>> {
      contractFor(name); // Unknown names fail when the wrapper is made, not on first use.
      validateMinTtlLedgers(guardOptions.minTtlLedgers);
      const fresh = guardOptions.fresh === true;
      const assertOpts: AssertWritableOptions | undefined =
        guardOptions.minTtlLedgers === undefined ? undefined : { minTtlLedgers: guardOptions.minTtlLedgers };
      return async (...args: A): Promise<Awaited<R>> => {
        if (fresh) {
          await assertWritableFresh(name, assertOpts);
        } else {
          assertWritable(name, assertOpts);
        }
        return await write(...args);
      };
    },

    health(): HealthReport {
      return buildHealth(states.values(), {
        passphrase: config.network.passphrase,
        networkVerified,
        usingFallback: endpoints.usingFallback,
        now: now(),
        maxStalenessMs,
      });
    },
  };
}

