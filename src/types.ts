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
  /** Network passphrase the RPC must report. A mismatch prevents start. */
  passphrase: string;
}

/** A validated config with every default applied. */
export interface WasmwardConfig {
  version: 1;
  network: NetworkConfig;
  pollIntervalMs: number;
  maxStalenessMs: number;
  /** Keyed by contract name. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`. */
  contracts: Record<string, ContractConfig>;
}
