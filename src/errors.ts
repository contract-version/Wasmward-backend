import type { Status } from './types.js';

/** One problem found while validating a config, located by JSON path. */
export interface ConfigIssue {
  /** JSON path such as `$.contracts.vault.supported[0].wasmHash`. `$` is the document root. */
  path: string;
  message: string;
}

/** Thrown when a config is invalid or does not match the network it is used on. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly ConfigIssue[];

  constructor(message: string, issues: readonly ConfigIssue[] = []) {
    super(message);
    this.issues = issues;
  }

  /** Builds an error whose message lists every issue with its path. `source` names the file, if any. */
  static fromIssues(issues: readonly ConfigIssue[], source?: string): ConfigError {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    const where = source === undefined ? '' : ` in ${source}`;
    return new ConfigError(`Invalid Wasmward config${where}:\n${lines.join('\n')}`, issues);
  }
}

/** Thrown instead of allowing a write to a contract whose live code is not known to be supported. */
export class WriteBlockedError extends Error {
  override readonly name = 'WriteBlockedError';
  /** Name of the contract in the config. */
  readonly contract: string;
  readonly status: Status;
  /** Lowercase hex Wasm hash last seen on chain, when one was seen. */
  readonly liveWasmHash: string | undefined;
  /** Why the write was blocked, as a sentence fragment. */
  readonly reason: string;

  constructor(details: { contract: string; status: Status; liveWasmHash?: string | undefined; reason: string }) {
    super(`Writes to '${details.contract}' are blocked: ${details.reason}`);
    this.contract = details.contract;
    this.status = details.status;
    this.liveWasmHash = details.liveWasmHash;
    this.reason = details.reason;
  }
}
