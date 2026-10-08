import type { ContractConfig, ContractState, LiveExecutable, Status } from './types.js';

/** The state of a contract before any lookup has completed. */
export function initialState(name: string, contract: ContractConfig): ContractState {
  return { name, contractId: contract.contractId, status: 'pending', consecutiveErrors: 0 };
}

/**
 * The status as it stands at `now`. A stored `supported` only counts while the last successful
 * lookup is recent enough, so a poller that stopped or hung cannot leave a stale `supported` in place.
 * Every writability decision goes through this function.
 */
export function effectiveStatus(state: ContractState, now: number, maxStalenessMs: number): Status {
  if (state.status !== 'supported') return state.status;
  if (state.lastSuccessAt === undefined) return 'pending';
  const age = now - state.lastSuccessAt;
  // A negative age means the clock moved backwards, so freshness cannot be shown: fail closed.
  // `!(age >= 0)` also catches NaN.
  if (!(age >= 0) || age > maxStalenessMs) return 'stale';
  return 'supported';
}

/** True only when the contract is `supported` and the last successful lookup is fresh. */
export function isWritable(state: ContractState, now: number, maxStalenessMs: number): boolean {
  return effectiveStatus(state, now, maxStalenessMs) === 'supported';
}

/**
 * Computes the next state from the previous state and one lookup result. Pure: no I/O, no clock.
 * - An `error` result keeps the previous status and hash. If no lookup ever succeeded the status stays
 *   `pending`; if the last success is older than `maxStalenessMs` it becomes `stale`.
 * - Any other result is a successful lookup: it resets the error count and refreshes `lastSuccessAt`.
 */
export function nextState(
  prev: ContractState,
  result: LiveExecutable,
  cfg: ContractConfig,
  now: number,
  maxStalenessMs: number,
): ContractState {
  if (result.kind === 'error') {
    let status = prev.status;
    if (prev.lastSuccessAt === undefined) {
      status = 'pending';
    } else if (now - prev.lastSuccessAt > maxStalenessMs) {
      status = 'stale';
    }
    return { ...prev, status, lastCheckedAt: now, lastError: result.message, consecutiveErrors: prev.consecutiveErrors + 1 };
  }

  const next: ContractState = {
    name: prev.name,
    contractId: prev.contractId,
    status: 'pending',
    lastCheckedAt: now,
    lastSuccessAt: now,
    consecutiveErrors: 0,
  };

  switch (result.kind) {
    case 'wasm': {
      next.liveWasmHash = result.wasmHash;
      next.liveUntilLedger = result.liveUntilLedger;
      next.latestLedger = result.latestLedger;
      const match = cfg.supported.find((version) => version.wasmHash === result.wasmHash);
      if (match === undefined) {
        next.status = 'unsupported';
      } else {
        next.status = 'supported';
        if (match.label !== undefined) next.matchedLabel = match.label;
      }
      return next;
    }
    case 'stellar-asset':
      next.status = 'stellar-asset';
      return next;
    case 'missing':
      next.status = 'missing';
      return next;
    case 'archived':
      next.status = 'archived';
      next.liveUntilLedger = result.liveUntilLedger;
      next.latestLedger = result.latestLedger;
      return next;
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * A sentence fragment explaining the contract's status at `now`, for error messages.
 * For a status that allows writes it says so; callers only use it for blocked statuses.
 */
export function describeBlock(state: ContractState, now: number, maxStalenessMs: number): string {
  const status = effectiveStatus(state, now, maxStalenessMs);
  const lastError = state.lastError === undefined ? '' : `; last error: ${state.lastError}`;
  switch (status) {
    case 'supported':
      return 'the live code is supported';
    case 'pending':
      return `no successful check of the live code has completed yet${lastError}`;
    case 'unsupported':
      return `live code ${state.liveWasmHash ?? '(unknown hash)'} is not in the supported list`;
    case 'stellar-asset':
      return 'the contract is a Stellar Asset Contract, which Wasmward does not guard';
    case 'missing':
      return 'no contract instance was found on this network';
    case 'archived':
      return 'the contract instance has expired (archived) and must be restored first';
    case 'stale': {
      const age = state.lastSuccessAt === undefined ? undefined : now - state.lastSuccessAt;
      const when = age !== undefined && age >= 0 ? `was ${seconds(age)} ago` : 'cannot be dated';
      return `the last successful check ${when}, outside the allowed ${seconds(maxStalenessMs)}${lastError}`;
    }
  }
}

/** Stellar closes a ledger about every 5 seconds. Used only to turn a number of ledgers into a rough time. */
export const SECONDS_PER_LEDGER = 5;

/** An instance with less than this many ledgers left (about 7 days) is worth extending soon. */
export const EXPIRY_WARNING_LEDGERS = (7 * 24 * 60 * 60) / SECONDS_PER_LEDGER;

/**
 * How many ledgers the instance had left when it was last looked up, or undefined when that is not known.
 * Zero means it had already reached the end of its life. This is a snapshot: it does not count down.
 */
export function ledgersUntilExpiry(state: ContractState): number | undefined {
  if (state.liveUntilLedger === undefined || state.latestLedger === undefined) return undefined;
  return Math.max(0, state.liveUntilLedger - state.latestLedger);
}

/** A rough, human time for a number of ledgers, such as "about 6 days" or "about 5 hours". */
export function describeTimeLeft(ledgers: number): string {
  const seconds = ledgers * SECONDS_PER_LEDGER;
  if (seconds < 60 * 60) return 'less than an hour';
  if (seconds < 2 * 24 * 60 * 60) return `about ${Math.round(seconds / 3600)} hours`;
  return `about ${Math.round(seconds / 86_400)} days`;
}
