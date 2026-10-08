import { randomBytes } from 'node:crypto';
import { access, link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ConfigDocument } from './config.js';
import { ConfigError } from './errors.js';
import type { GuardServer } from './guard.js';
import { hashWasm } from './hash.js';
import { buildHealth, type HealthReport } from './health.js';
import { describeBlock, initialState, nextState } from './state.js';
import type { ContractState, WasmwardConfig } from './types.js';

// The Stellar SDK is large and slow to load. These modules pull it in, so they are imported only by
// the commands that need them, which keeps `wasmward hash` instant.
const loadConfigModule = () => import('./config.js');
const loadNodeModule = () => import('./node.js');
const loadEndpointsModule = () => import('./endpoints.js');
const loadGuardModule = () => import('./guard.js');

/** Exit codes, as documented for deploy gates. */
export const EXIT_OK = 0;
export const EXIT_NOT_SUPPORTED = 1;
export const EXIT_ERROR = 2;

const DEFAULT_CONFIG_PATH = './wasmward.json';
const MAX_LOOKUP_TIMEOUT_MS = 10_000;

const USAGE = `Usage:
  wasmward init <name> <contract-id> (--preset <testnet|mainnet> | --rpc-url <url> --passphrase <text>)
               [--wasm <file.wasm>] [--label <label>] [--rpc-url <url>] [--config <path>] [--json]
  wasmward hash <file.wasm> [--json]
  wasmward add <name> <file.wasm> --label <label> [--config <path>] [--network <name>] [--json]
  wasmward check [--config <path>] [--network <name>] [--json]
  wasmward watch [--config <path>] [--network <name>] [--json]

Commands:
  init    Create a new config for one contract, starting from a Wasm file you trust (--wasm)
          or, failing that, the code that is live on the network right now.
  hash    Print the lowercase SHA-256 hash of a Wasm file.
  add     Add a Wasm file's hash to a contract's supported list in the config.
  check   Look up the live code of every configured contract and report its status.
          With a multi-network config and no --network, every network is checked.
  watch   Keep checking and print each status change until interrupted (Ctrl+C).

Exit codes:
  0  success; for check, every contract is supported; for watch, stopped by Ctrl+C
  1  check: at least one contract is not supported
  2  invalid input, unreadable file, invalid config, or the network could not be checked
     (for watch, also if it cannot start)

Options:
  --config <path>  Config file (default ${DEFAULT_CONFIG_PATH})
  --network <name> Which network, for a config with a "networks" section
  --label <label>  Label for the version being added (init: default "initial")
  --preset <name>  init: testnet (public RPC included) or mainnet (you must give --rpc-url)
  --rpc-url <url>  init: the RPC endpoint
  --passphrase <t> init: the network passphrase, when not using --preset
  --wasm <file>    init: take the first supported hash from this build instead of from the network
  --json           Machine-readable output
  -h, --help       Show this help
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Builds the RPC client `check` uses. Defaults to a real `rpc.Server`. */
  createServer?: (config: WasmwardConfig) => GuardServer | Promise<GuardServer>;
  /** Builds the fallback RPC clients `check` may use. Defaults to one `rpc.Server` per `fallbackRpcUrls` entry. */
  createFallbackServers?: (config: WasmwardConfig) => GuardServer[] | Promise<GuardServer[]>;
  /** Clock in milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Ends `watch` when aborted. The entry point aborts it on Ctrl+C or SIGTERM. */
  signal?: AbortSignal;
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

async function rpcServerFor(url: string): Promise<GuardServer> {
  const { rpc } = await import('@stellar/stellar-sdk');
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') });
}

async function defaultServer(config: WasmwardConfig): Promise<GuardServer> {
  return rpcServerFor(config.network.rpcUrl);
}

async function defaultFallbackServers(config: WasmwardConfig): Promise<GuardServer[]> {
  return Promise.all(config.network.fallbackRpcUrls.map(rpcServerFor));
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
  // Validate before touching anything; this throws a ConfigError naming every problem, in every network.
  const { loadConfigDocument } = await loadConfigModule();
  loadConfigDocument(parsed, { source: path });
  return parsed as Record<string, unknown>;
}

/**
 * Picks the network a command acts on. It never guesses between several: choosing for the user could
 * point a command at mainnet when it meant testnet. A single network is used as is, and naming one for a
 * single-network file is an error, for the same reason.
 */
function selectNetwork(
  document: ConfigDocument,
  requested: string | undefined,
): { name: string | undefined; config: WasmwardConfig } {
  if (document.kind === 'single') {
    if (requested !== undefined) {
      throw new CliError(`This config describes a single network, so --network ${requested} does not apply.`);
    }
    return { name: undefined, config: document.config };
  }
  const names = Object.keys(document.networks);
  if (requested === undefined) {
    const only = names.length === 1 ? names[0] : undefined;
    const config = only === undefined ? undefined : document.networks[only];
    if (only === undefined || config === undefined) {
      throw new CliError(`This config describes ${names.length} networks (${names.join(', ')}); choose one with --network <name>.`);
    }
    return { name: only, config };
  }
  const config = Object.hasOwn(document.networks, requested) ? document.networks[requested] : undefined;
  if (config === undefined) {
    throw new CliError(`Unknown network '${requested}'. This config has: ${names.join(', ')}.`);
  }
  return { name: requested, config };
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

/** Networks init knows, so a config does not need the passphrase typed out. */
const PRESETS: Record<string, { rpcUrl: string | undefined; passphrase: string }> = {
  testnet: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
  // The Stellar Development Foundation does not run a public mainnet RPC; use your own provider.
  mainnet: { rpcUrl: undefined, passphrase: 'Public Global Stellar Network ; September 2015' },
};

/** Creates a file only if it does not exist, writing it whole or not at all. */
async function createFileExclusive(path: string, text: string): Promise<void> {
  const exists = (): CliError =>
    new CliError(`${path} already exists. init never overwrites a file; delete it or choose another with --config.`);
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.wasmward.tmp`);
  try {
    await writeFile(temp, text, 'utf8');
    try {
      await link(temp, path); // fails if the path exists, so two runs cannot overwrite each other
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw exists();
      // Some file systems cannot make hard links; an exclusive create is the next best thing.
      try {
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') throw exists();
        throw fallback;
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

async function initCommand(
  positionals: string[],
  options: {
    config: string;
    label: string | undefined;
    wasm: string | undefined;
    preset: string | undefined;
    rpcUrl: string | undefined;
    passphrase: string | undefined;
    json: boolean;
  },
  io: CliIo,
): Promise<number> {
  const [name, contractId, ...extra] = positionals;
  if (name === undefined || contractId === undefined || extra.length > 0) {
    throw new CliError(
      'Usage: wasmward init <name> <contract-id> (--preset <testnet|mainnet> | --rpc-url <url> --passphrase <text>) [--wasm <file.wasm>]',
    );
  }

  const preset = options.preset === undefined ? undefined : Object.hasOwn(PRESETS, options.preset) ? PRESETS[options.preset] : undefined;
  if (options.preset !== undefined && preset === undefined) {
    throw new CliError(`Unknown preset '${options.preset}'. Choose one of: ${Object.keys(PRESETS).join(', ')}.`);
  }
  if (preset !== undefined && options.passphrase !== undefined && options.passphrase !== preset.passphrase) {
    throw new CliError(`--passphrase does not match the ${options.preset} preset. Use one or the other.`);
  }
  const rpcUrl = options.rpcUrl ?? preset?.rpcUrl;
  const passphrase = options.passphrase ?? preset?.passphrase;
  if (rpcUrl === undefined || passphrase === undefined) {
    throw new CliError(
      options.preset === 'mainnet' && rpcUrl === undefined
        ? 'The mainnet preset needs your own RPC endpoint: add --rpc-url <url>.'
        : 'Say which network: --preset <testnet|mainnet>, or both --rpc-url and --passphrase.',
    );
  }

  // Fail before any network work if the file is already there.
  let alreadyThere = false;
  try {
    await access(options.config);
    alreadyThere = true;
  } catch {
    // Not there, which is what we want.
  }
  if (alreadyThere) {
    throw new CliError(`${options.config} already exists. init never overwrites a file; delete it or choose another with --config.`);
  }

  const { loadConfig } = await loadConfigModule();
  const draft = (wasmHash: string, label: string): Record<string, unknown> => ({
    version: 1,
    network: { rpcUrl, passphrase },
    contracts: { [name]: { contractId, supported: [{ wasmHash, label }] } },
  });
  const label = options.label ?? 'initial';

  let wasmHash: string;
  let source: 'wasm-file' | 'network';
  if (options.wasm !== undefined) {
    wasmHash = await hashWasm(await readWasm(options.wasm));
    source = 'wasm-file';
    loadConfig(draft(wasmHash, label), { source: 'the new config' });
  } else {
    // Validate everything else first, with a placeholder hash, so a typo does not cost a network call.
    const placeholder = loadConfig(draft('0'.repeat(64), label), { source: 'the new config' });
    const { createEndpointSet } = await loadEndpointsModule();
    const timeoutMs = Math.min(placeholder.pollIntervalMs, MAX_LOOKUP_TIMEOUT_MS);
    const server = await (io.createServer ?? defaultServer)(placeholder);
    const endpoints = createEndpointSet([server], passphrase, timeoutMs);
    try {
      await endpoints.verifyNetwork();
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new CliError(messageOf(error));
    }
    const result = (await endpoints.lookup([contractId], timeoutMs)).get(contractId);
    if (result === undefined || result.kind === 'error') {
      throw new CliError(`Could not read the live code of ${contractId}: ${result?.kind === 'error' ? result.message : 'no answer'}`);
    }
    if (result.kind === 'missing') throw new CliError(`No contract with ID ${contractId} exists on this network.`);
    if (result.kind === 'archived') throw new CliError(`The instance of ${contractId} has expired (archived); restore it first.`);
    if (result.kind === 'stellar-asset') {
      throw new CliError(`${contractId} is a Stellar Asset Contract. Wasmward guards contracts that run Wasm code.`);
    }
    wasmHash = result.wasmHash;
    source = 'network';
    if (!options.json) {
      io.stderr(
        'Starting from the code that is live right now. That trusts the RPC and whoever deployed it; ' +
          'to start from a build you trust, run init again with --wasm <file.wasm>.\n',
      );
    }
  }

  const document = draft(wasmHash, label);
  loadConfig(document, { source: 'the new config' }); // never write what would not load
  await createFileExclusive(options.config, `${JSON.stringify(document, null, 2)}\n`);
  io.stdout(
    options.json
      ? jsonLine({ config: options.config, contract: name, contractId, wasmHash, label, source })
      : `Created ${options.config}: '${name}' supports ${label} (${wasmHash}), taken from ${source === 'wasm-file' ? options.wasm : 'the network'}.\n`,
  );
  return EXIT_OK;
}

async function addCommand(
  positionals: string[],
  options: { config: string; network: string | undefined; label: string | undefined; json: boolean },
  io: CliIo,
): Promise<number> {
  const [name, file, ...extra] = positionals;
  if (name === undefined || file === undefined || extra.length > 0) {
    throw new CliError('Usage: wasmward add <name> <file.wasm> --label <label> [--config <path>] [--network <name>]');
  }
  if (options.label === undefined) throw new CliError('--label is required, for example --label v1.2.0');

  const raw = await readRawConfig(options.config);
  const { loadConfigDocument } = await loadConfigModule();
  const document = loadConfigDocument(raw);
  const { name: networkName, config: current } = selectNetwork(document, options.network);
  const where = networkName === undefined ? '' : ` on ${networkName}`;

  const contract = Object.hasOwn(current.contracts, name) ? current.contracts[name] : undefined;
  if (contract === undefined) {
    throw new CliError(`Unknown contract '${name}'${where}. Configured contracts: ${Object.keys(current.contracts).join(', ')}.`);
  }

  const wasmHash = await hashWasm(await readWasm(file));
  const existing = contract.supported.find((version) => version.wasmHash === wasmHash);
  if (existing !== undefined) {
    const as = existing.label === undefined ? '' : ` as '${existing.label}'`;
    throw new CliError(`${wasmHash} is already supported for '${name}'${where}${as}. Nothing was changed.`);
  }

  // Edit the raw document, not the loaded one, so the file keeps its own key order and omits defaults.
  const section =
    networkName === undefined ? raw : (raw['networks'] as Record<string, Record<string, unknown>>)[networkName];
  const rawContract = (section?.['contracts'] as Record<string, { supported: unknown[] }> | undefined)?.[name];
  rawContract?.supported.push({ wasmHash, label: options.label });
  loadConfigDocument(raw, { source: `${options.config} (with the new version)` });

  await writeFileAtomic(options.config, `${JSON.stringify(raw, null, 2)}\n`);
  io.stdout(
    options.json
      ? jsonLine({
          contract: name,
          ...(networkName === undefined ? {} : { network: networkName }),
          wasmHash,
          label: options.label,
          config: options.config,
        })
      : `Added ${options.label} (${wasmHash}) to '${name}'${where} in ${options.config}\n`,
  );
  return EXIT_OK;
}

async function watchCommand(options: { config: string; network: string | undefined; json: boolean }, io: CliIo): Promise<number> {
  const signal = io.signal;
  if (signal === undefined) throw new CliError('Internal error: watch needs a signal to know when to stop.');
  const { loadConfigDocumentFile } = await loadNodeModule();
  const { createVersionGuard } = await loadGuardModule();
  const { name: networkName, config } = selectNetwork(await loadConfigDocumentFile(options.config), options.network);
  const now = io.now ?? Date.now;
  const server = await (io.createServer ?? defaultServer)(config);
  const guard = createVersionGuard(config, { server, now });

  const report = (state: ContractState, from: string): void => {
    const at = new Date(now()).toISOString();
    const reason = state.status === 'supported' ? undefined : describeBlock(state, now(), config.maxStalenessMs);
    if (options.json) {
      const line: Record<string, unknown> = { time: at, contract: state.name, from, to: state.status };
      if (networkName !== undefined) line['network'] = networkName;
      if (state.liveWasmHash !== undefined) line['liveWasmHash'] = state.liveWasmHash;
      if (state.matchedLabel !== undefined) line['matchedLabel'] = state.matchedLabel;
      if (reason !== undefined) line['reason'] = reason;
      io.stdout(jsonLine(line));
      return;
    }
    const detail =
      reason ?? `${state.liveWasmHash ?? ''}${state.matchedLabel === undefined ? '' : ` (${state.matchedLabel})`}`;
    const label = networkName === undefined ? state.name : `${networkName}/${state.name}`;
    io.stdout(`${at} ${label}: ${from} -> ${state.status}  ${detail}
`);
  };

  guard.subscribe((change) => report(change.state, change.from));
  try {
    await guard.start();
  } catch (error) {
    throw new CliError(messageOf(error));
  }
  // A contract whose first lookup failed has not changed status, so it has not been reported yet.
  for (const state of Object.values(guard.status())) {
    if (state.status === 'pending') report(state, 'pending');
  }
  if (!options.json) io.stderr(`Watching ${Object.keys(config.contracts).length} contract(s)${networkName === undefined ? '' : ` on ${networkName}`}. Press Ctrl+C to stop.
`);

  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  await guard.stop();
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

interface CheckOutcome {
  exitCode: number;
  text: string;
  report: HealthReport;
  lookupFailed: boolean;
}

/** Checks one network. Throws {@link CliError} or {@link ConfigError} when it cannot even be reached. */
async function checkNetwork(config: WasmwardConfig, io: CliIo): Promise<CheckOutcome> {
  const { createEndpointSet } = await loadEndpointsModule();
  const servers = [
    await (io.createServer ?? defaultServer)(config),
    ...(await (io.createFallbackServers ?? defaultFallbackServers)(config)),
  ];
  const now = io.now ?? Date.now;
  const timeoutMs = Math.min(config.pollIntervalMs, MAX_LOOKUP_TIMEOUT_MS);
  const endpoints = createEndpointSet(servers, config.network.passphrase, timeoutMs);

  // A wrong network is a ConfigError and ends the check with exit code 2; so does an unreachable RPC.
  try {
    await endpoints.verifyNetwork();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new CliError(messageOf(error));
  }

  const startedAt = now();
  const names = Object.keys(config.contracts);
  const results = await endpoints.lookup(
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
  return {
    exitCode: lookupFailed ? EXIT_ERROR : allSupported ? EXIT_OK : EXIT_NOT_SUPPORTED,
    text: renderCheck(states, config, startedAt),
    report: buildHealth(states, {
      passphrase: config.network.passphrase,
      networkVerified: true,
      usingFallback: endpoints.usingFallback,
      now: startedAt,
      maxStalenessMs: config.maxStalenessMs,
    }),
    lookupFailed,
  };
}

const LOOKUP_FAILED_NOTE = 'Some contracts could not be looked up; see the messages above.\n';

async function checkCommand(options: { config: string; network: string | undefined; json: boolean }, io: CliIo): Promise<number> {
  const { loadConfigDocumentFile } = await loadNodeModule();
  const document = await loadConfigDocumentFile(options.config);

  // One network, chosen by the file or by --network: errors end the command with exit code 2.
  if (document.kind === 'single' || options.network !== undefined) {
    const { config } = selectNetwork(document, options.network);
    const outcome = await checkNetwork(config, io);
    if (options.json) {
      io.stdout(jsonLine({ ...outcome.report, exitCode: outcome.exitCode }));
    } else {
      io.stdout(outcome.text);
      if (outcome.lookupFailed) io.stderr(LOOKUP_FAILED_NOTE);
    }
    return outcome.exitCode;
  }

  // Several networks and none chosen: check them all. One network failing does not hide the others.
  const results: { name: string; outcome?: CheckOutcome; error?: string }[] = [];
  for (const [name, config] of Object.entries(document.networks)) {
    try {
      results.push({ name, outcome: await checkNetwork(config, io) });
    } catch (error) {
      if (!(error instanceof CliError) && !(error instanceof ConfigError)) throw error;
      results.push({ name, error: error.message });
    }
  }
  // 2 (could not check) outranks 1 (not supported), which outranks 0.
  const exitCode = Math.max(...results.map((result) => (result.outcome === undefined ? EXIT_ERROR : result.outcome.exitCode)));

  if (options.json) {
    const networks: Record<string, unknown> = {};
    for (const { name, outcome, error } of results) {
      networks[name] =
        outcome === undefined
          ? { ok: false, error, exitCode: EXIT_ERROR }
          : { ...outcome.report, exitCode: outcome.exitCode };
    }
    const ok = results.every((result) => result.outcome?.report.ok === true);
    io.stdout(jsonLine({ ok, exitCode, networks }));
  } else {
    for (const { name, outcome, error } of results) {
      io.stdout(`== ${name} ==\n${outcome === undefined ? `could not be checked: ${error}\n` : outcome.text}`);
    }
    if (results.some((result) => result.outcome === undefined || result.outcome.lookupFailed)) io.stderr(LOOKUP_FAILED_NOTE);
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
      case 'init':
        return await initCommand(
          rest,
          {
            config,
            label: values.label,
            wasm: values.wasm,
            preset: values.preset,
            rpcUrl: values['rpc-url'],
            passphrase: values.passphrase,
            json: values.json === true,
          },
          io,
        );
      case 'add':
        return await addCommand(rest, { config, network: values.network, label: values.label, json: values.json === true }, io);
      case 'check':
        if (rest.length > 0) throw new CliError('Usage: wasmward check [--config <path>] [--network <name>] [--json]');
        return await checkCommand({ config, network: values.network, json: values.json === true }, io);
      case 'watch':
        if (rest.length > 0) throw new CliError('Usage: wasmward watch [--config <path>] [--network <name>] [--json]');
        return await watchCommand({ config, network: values.network, json: values.json === true }, io);
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
      network: { type: 'string' },
      label: { type: 'string' },
      wasm: { type: 'string' },
      preset: { type: 'string' },
      'rpc-url': { type: 'string' },
      passphrase: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
