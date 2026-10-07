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
      return next;
  }
}
