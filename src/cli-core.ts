import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from './errors.js';
import type { GuardServer } from './guard.js';
import { hashWasm } from './hash.js';
import { buildHealth } from './health.js';
import { describeBlock, initialState, nextState } from './state.js';
import type { ContractState, WasmwardConfig } from './types.js';

// The Stellar SDK is large and slow to load. These modules pull it in, so they are imported only by
// the commands that need them, which keeps `wasmward hash` instant.
const loadConfigModule = () => import('./config.js');
const loadNodeModule = () => import('./node.js');
const loadFetchModule = () => import('./fetch.js');

/** Exit codes, as documented for deploy gates. */
export const EXIT_OK = 0;
export const EXIT_NOT_SUPPORTED = 1;
export const EXIT_ERROR = 2;

const DEFAULT_CONFIG_PATH = './wasmward.json';
const MAX_LOOKUP_TIMEOUT_MS = 10_000;

const USAGE = `Usage:
  wasmward hash <file.wasm> [--json]
  wasmward add <name> <file.wasm> --label <label> [--config <path>] [--json]
  wasmward check [--config <path>] [--json]

Commands:
  hash    Print the lowercase SHA-256 hash of a Wasm file.
  add     Add a Wasm file's hash to a contract's supported list in the config.
  check   Look up the live code of every configured contract and report its status.

Exit codes:
  0  success; for check, every contract is supported
  1  check: at least one contract is not supported
  2  invalid input, unreadable file, invalid config, or the network could not be checked

Options:
  --config <path>  Config file (default ${DEFAULT_CONFIG_PATH})
  --label <label>  Label for the version being added
  --json           Machine-readable output
  -h, --help       Show this help
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Builds the RPC client `check` uses. Defaults to a real `rpc.Server`. */
  createServer?: (config: WasmwardConfig) => GuardServer | Promise<GuardServer>;
  /** Clock in milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: () => number;
}

/** Thrown inside a command to end it with a message and an exit code. */
class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = EXIT_ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultServer(config: WasmwardConfig): Promise<GuardServer> {
  const { rpc } = await import('@stellar/stellar-sdk');
  return new rpc.Server(config.network.rpcUrl, { allowHttp: config.network.rpcUrl.startsWith('http://') });
}

/** Writes through a temporary file in the same folder, then renames, so readers never see half a file. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.wasmward.tmp`);
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readWasm(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${messageOf(error)}`);
  }
}

async function readRawConfig(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${messageOf(error)}`);
  }
  // Validate before touching anything; this throws a ConfigError naming every problem.
  const { loadConfig } = await loadConfigModule();
  loadConfig(parsed, { source: path });
  return parsed as Record<string, unknown>;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function hashCommand(files: string[], json: boolean, io: CliIo): Promise<number> {
  const [file, ...extra] = files;
  if (file === undefined || extra.length > 0) throw new CliError('Usage: wasmward hash <file.wasm>');
  const wasmHash = await hashWasm(await readWasm(file));
  io.stdout(json ? jsonLine({ file, wasmHash }) : `${wasmHash}\n`);
  return EXIT_OK;
}

async function addCommand(
  positionals: string[],
  options: { config: string; label: string | undefined; json: boolean },
  io: CliIo,
): Promise<number> {
  const [name, file, ...extra] = positionals;
  if (name === undefined || file === undefined || extra.length > 0) {
    throw new CliError('Usage: wasmward add <name> <file.wasm> --label <label> [--config <path>]');
  }
  if (options.label === undefined) throw new CliError('--label is required, for example --label v1.2.0');

  const raw = await readRawConfig(options.config);
  const { loadConfig } = await loadConfigModule();
  const current = loadConfig(raw);
  const contract = Object.hasOwn(current.contracts, name) ? current.contracts[name] : undefined;
  if (contract === undefined) {
    throw new CliError(`Unknown contract '${name}'. Configured contracts: ${Object.keys(current.contracts).join(', ')}.`);
  }

  const wasmHash = await hashWasm(await readWasm(file));
  const existing = contract.supported.find((version) => version.wasmHash === wasmHash);
  if (existing !== undefined) {
    const as = existing.label === undefined ? '' : ` as '${existing.label}'`;
    throw new CliError(`${wasmHash} is already supported for '${name}'${as}. Nothing was changed.`);
  }

  // Edit the raw document, not the loaded one, so the file keeps its own key order and omits defaults.
  const rawContract = (raw['contracts'] as Record<string, { supported: unknown[] }>)[name];
  rawContract?.supported.push({ wasmHash, label: options.label });
  loadConfig(raw, { source: `${options.config} (with the new version)` });

  await writeFileAtomic(options.config, `${JSON.stringify(raw, null, 2)}\n`);
  io.stdout(
    options.json
      ? jsonLine({ contract: name, wasmHash, label: options.label, config: options.config })
      : `Added ${options.label} (${wasmHash}) to '${name}' in ${options.config}\n`,
  );
  return EXIT_OK;
}

function renderCheck(states: ContractState[], config: WasmwardConfig, now: number): string {
  const width = Math.max(...states.map((state) => state.name.length));
  const lines = [`Network: ${config.network.passphrase}`];
  let supported = 0;
  for (const state of states) {
    const label = state.name.padEnd(width);
    if (state.status === 'supported') {
      supported += 1;
      const matched = state.matchedLabel === undefined ? '' : ` (${state.matchedLabel})`;
      lines.push(`${label}  supported${matched}  ${state.liveWasmHash ?? ''}`);
    } else {
      lines.push(`${label}  ${state.status}: ${describeBlock(state, now, config.maxStalenessMs)}`);
    }
  }
  lines.push(`${supported} of ${states.length} contracts supported.`);
  return `${lines.join('\n')}\n`;
}

async function checkCommand(options: { config: string; json: boolean }, io: CliIo): Promise<number> {
  const { loadConfigFile } = await loadNodeModule();
  const { fetchExecutables, withTimeout } = await loadFetchModule();
  const config = await loadConfigFile(options.config);
  const server = await (io.createServer ?? defaultServer)(config);
  const now = io.now ?? Date.now;
  const timeoutMs = Math.min(config.pollIntervalMs, MAX_LOOKUP_TIMEOUT_MS);

  let passphrase: string;
  try {
    passphrase = (await withTimeout(server.getNetwork(), timeoutMs, 'getNetwork')).passphrase;
  } catch (error) {
    throw new CliError(`Could not reach the RPC to verify the network: ${messageOf(error)}`);
  }
  if (passphrase !== config.network.passphrase) {
    throw new CliError(`The RPC serves network "${passphrase}" but the config expects "${config.network.passphrase}".`);
  }

  const startedAt = now();
  const names = Object.keys(config.contracts);
  const results = await fetchExecutables(
    server,
    names.map((name) => config.contracts[name]?.contractId ?? ''),
    timeoutMs,
  );
  const states = names.map((name) => {
    const contract = config.contracts[name];
    if (contract === undefined) throw new CliError(`Internal error: no config for '${name}'.`);
    const result = results.get(contract.contractId) ?? { kind: 'error' as const, message: 'no result returned' };
    return nextState(initialState(name, contract), result, contract, startedAt, config.maxStalenessMs);
  });

  // A lookup that errored means the live code could not be determined at all: report it as an
  // error (2) rather than as "not supported" (1), since the contract might well be fine.
  const lookupFailed = states.some((state) => state.lastError !== undefined);
  const allSupported = states.every((state) => state.status === 'supported');
  const exitCode = lookupFailed ? EXIT_ERROR : allSupported ? EXIT_OK : EXIT_NOT_SUPPORTED;

  if (options.json) {
    const report = buildHealth(states, {
      passphrase,
      networkVerified: true,
      now: startedAt,
      maxStalenessMs: config.maxStalenessMs,
    });
    io.stdout(jsonLine({ ...report, exitCode }));
  } else {
    io.stdout(renderCheck(states, config, startedAt));
    if (lookupFailed) io.stderr('Some contracts could not be looked up; see the messages above.\n');
  }
  return exitCode;
}

/** Runs the CLI and returns the exit code. Never throws and never exits the process itself. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const json = argv.includes('--json');
  const fail = (message: string, exitCode: number): number => {
    if (json) io.stdout(jsonLine({ ok: false, error: message, exitCode }));
    else io.stderr(`${message}\n`);
    return exitCode;
  };

  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    return fail(`${messageOf(error)}\n\n${USAGE}`.trimEnd(), EXIT_ERROR);
  }

  const { positionals, values } = parsed;
  const [command, ...rest] = positionals;
  if (values.help === true) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (command === undefined) {
    io.stderr(USAGE);
    return EXIT_ERROR;
  }

  try {
    const config = values.config ?? DEFAULT_CONFIG_PATH;
    switch (command) {
      case 'hash':
        return await hashCommand(rest, values.json === true, io);
      case 'add':
        return await addCommand(rest, { config, label: values.label, json: values.json === true }, io);
      case 'check':
        if (rest.length > 0) throw new CliError('Usage: wasmward check [--config <path>] [--json]');
        return await checkCommand({ config, json: values.json === true }, io);
      default:
        throw new CliError(`Unknown command '${command}'.\n\n${USAGE.trimEnd()}`);
    }
  } catch (error) {
    if (error instanceof CliError) return fail(error.message, error.exitCode);
    if (error instanceof ConfigError) return fail(error.message, EXIT_ERROR);
    return fail(`Unexpected error: ${messageOf(error)}`, EXIT_ERROR);
  }
}

function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      label: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
