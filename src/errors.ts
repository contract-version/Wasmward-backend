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
