/** One Wasm build the app declares it can talk to. */
export interface SupportedVersion {
  /** Lowercase hex SHA-256 of the Wasm bytes (64 characters). */
  wasmHash: string;
  /** Human-readable name for the build, for example "v1.0.0". */
  label?: string;
}

export interface ContractConfig {
  /** Contract address, a StrKey starting with "C". */
  contractId: string;
  /** Wasm builds the app supports. Never empty, no duplicate hashes. */
  supported: SupportedVersion[];
}

export interface NetworkConfig {
  rpcUrl: string;
  /** Other RPC endpoints to use, in order, when the primary cannot answer. Often empty. */
  fallbackRpcUrls: string[];
  /** Network passphrase the RPC must report. A mismatch prevents start. */
  passphrase: string;
}

/**
 * A config as you may write it in code: the same as {@link WasmwardConfig}, except that anything with a
 * default may be left out (`network.fallbackRpcUrls`, `pollIntervalMs`, `maxStalenessMs`).
 * `createVersionGuard` accepts this and validates it again.
 */
export type WasmwardConfigInput = Omit<WasmwardConfig, 'network' | 'pollIntervalMs' | 'maxStalenessMs'> & {
  network: Omit<NetworkConfig, 'fallbackRpcUrls'> & { fallbackRpcUrls?: string[] };
  pollIntervalMs?: number;
  maxStalenessMs?: number;
};

/** A validated config with every default applied. */
export interface WasmwardConfig {
  version: 1;
  network: NetworkConfig;
  pollIntervalMs: number;
  maxStalenessMs: number;
  /** Keyed by contract name. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`. */
  contracts: Record<string, ContractConfig>;
}

/** What a contract instance is running right now, or why that could not be determined. */
export type LiveExecutable =
  | { kind: 'wasm'; wasmHash: string; liveUntilLedger: number; codeLiveUntilLedger: number; latestLedger: number }
  | { kind: 'stellar-asset'; latestLedger: number }
  /** No instance entry was found. The contract does not exist on this network. */
  | { kind: 'missing'; latestLedger: number }
  /**
   * Something the contract needs has expired. By default the instance; `entry: 'code'` means the instance is
   * live but the ledger entry holding its Wasm is not (expired, or not found), so calls would fail.
   */
  | { kind: 'archived'; liveUntilLedger?: number; latestLedger: number; entry?: 'code'; wasmHash?: string }
  | { kind: 'error'; message: string };

/** Why a contract is, or is not, safe to write to. Only `supported` allows writes. */
export type Status =
  | 'pending'
  | 'supported'
  | 'unsupported'
  | 'stellar-asset'
  | 'missing'
  | 'archived'
  | 'stale';

export interface ContractState {
  name: string;
  contractId: string;
  status: Status;
  /** Lowercase hex Wasm hash seen on the last successful lookup that found Wasm. */
  liveWasmHash?: string;
  /** Ledger after which the contract instance expires, as of the last lookup that found one. */
  liveUntilLedger?: number;
  /** Ledger after which the entry holding the contract's Wasm expires. It has its own lifetime. */
  codeLiveUntilLedger?: number;
  /** Set to `code` when the status is `archived` because the Wasm entry expired, not the instance. */
  archivedEntry?: 'code';
  /** The latest ledger the RPC reported on that lookup, so the two can be compared. */
  latestLedger?: number;
  /** Label of the supported version the live hash matched, when it has one. */
  matchedLabel?: string;
  /** Time of the last lookup, successful or not. */
  lastCheckedAt?: number;
  /** Time of the last lookup that completed without error. */
  lastSuccessAt?: number;
  lastError?: string;
  consecutiveErrors: number;
}
