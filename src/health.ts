import { effectiveStatus } from './state.js';
import type { ContractState, Status } from './types.js';

export interface ContractHealth {
  contractId: string;
  /** Status as of `checkedAt`, with staleness applied. */
  status: Status;
  /** True only when `status` is `supported`. */
  writable: boolean;
  liveWasmHash?: string;
  matchedLabel?: string;
  lastCheckedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  consecutiveErrors: number;
}

/** Plain JSON, safe to return from any HTTP framework. */
export interface HealthReport {
  /** True only when the network was verified and every contract is `supported`. */
  ok: boolean;
  network: {
    passphrase: string;
    /** False until `start()` has confirmed the RPC serves this network. */
    verified: boolean;
  };
  contracts: Record<string, ContractHealth>;
  /** Milliseconds since the Unix epoch when this report was computed. */
  checkedAt: number;
}

/**
 * Builds the health report. The RPC URL is left out on purpose: it can carry an API key, and health
 * output is often exposed to monitoring systems or the public.
 */
export function buildHealth(
  states: Iterable<ContractState>,
  options: { passphrase: string; networkVerified: boolean; now: number; maxStalenessMs: number },
): HealthReport {
  const contracts: Record<string, ContractHealth> = {};
  let allSupported = true;

  for (const state of states) {
    const status = effectiveStatus(state, options.now, options.maxStalenessMs);
    const entry: ContractHealth = {
      contractId: state.contractId,
      status,
      writable: status === 'supported',
      consecutiveErrors: state.consecutiveErrors,
    };
    if (state.liveWasmHash !== undefined) entry.liveWasmHash = state.liveWasmHash;
    if (state.matchedLabel !== undefined) entry.matchedLabel = state.matchedLabel;
    if (state.lastCheckedAt !== undefined) entry.lastCheckedAt = state.lastCheckedAt;
    if (state.lastSuccessAt !== undefined) entry.lastSuccessAt = state.lastSuccessAt;
    if (state.lastError !== undefined) entry.lastError = state.lastError;
    contracts[state.name] = entry;
    if (status !== 'supported') allSupported = false;
  }

  return {
    ok: options.networkVerified && allSupported,
    network: { passphrase: options.passphrase, verified: options.networkVerified },
    contracts,
    checkedAt: options.now,
  };
}
