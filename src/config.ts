import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { ConfigError, type ConfigIssue } from './errors.js';
import type { ContractConfig, WasmwardConfig } from './types.js';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 5_000;
/** One day. Anything longer is not polling, and the timers behind it cannot wait that long reliably. */
export const MAX_POLL_INTERVAL_MS = 86_400_000;
/** `maxStalenessMs` defaults to this many poll intervals. */
const DEFAULT_STALENESS_FACTOR = 4;
/** `maxStalenessMs` may not be smaller than this many poll intervals. */
const MIN_STALENESS_FACTOR = 2;

const CONTRACT_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const WASM_HASH = /^[0-9a-fA-F]{64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Compares URLs without caring about case in the host, a default port, or a trailing slash. */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return value;
  }
}

function isAllowedRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

const supportedVersionSchema = z.strictObject({
  wasmHash: z
    .string()
    .regex(WASM_HASH, 'must be exactly 64 hex characters')
    .transform((hash) => hash.toLowerCase()),
  label: z.string().min(1, 'must not be empty').max(64, 'must be at most 64 characters').optional(),
});

const contractSchema = z
  .strictObject({
    contractId: z
      .string()
      .refine((id) => StrKey.isValidContract(id), 'must be a valid contract ID (a StrKey starting with "C")'),
    supported: z.array(supportedVersionSchema).min(1, 'must list at least one supported version'),
  })
  .superRefine((contract, ctx) => {
    const firstSeen = new Map<string, number>();
    contract.supported.forEach((version, index) => {
      const first = firstSeen.get(version.wasmHash);
      if (first === undefined) {
        firstSeen.set(version.wasmHash, index);
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['supported', index, 'wasmHash'],
          message: `duplicate of supported[${first}]`,
        });
      }
    });
  });

const rpcUrlSchema = z
  .string()
  .refine(isAllowedRpcUrl, 'must be an https URL (http is allowed only for localhost or 127.0.0.1)');

/** At most this many fallbacks: more only slows a failing lookup down. */
export const MAX_FALLBACK_RPC_URLS = 4;

const networkSchema = z
  .strictObject({
    rpcUrl: rpcUrlSchema,
    fallbackRpcUrls: z
      .array(rpcUrlSchema)
      .max(MAX_FALLBACK_RPC_URLS, `must list at most ${MAX_FALLBACK_RPC_URLS} URLs`)
      .optional(),
    passphrase: z.string().min(1, 'must not be empty'),
  })
  .superRefine((network, ctx) => {
    // Repeating an endpoint only makes a failing lookup slower, and usually means a typo.
    const seen = new Map<string, string>([[normalizeUrl(network.rpcUrl), 'rpcUrl']]);
    (network.fallbackRpcUrls ?? []).forEach((url, index) => {
      const where = seen.get(normalizeUrl(url));
      if (where === undefined) {
        seen.set(normalizeUrl(url), `fallbackRpcUrls[${index}]`);
      } else {
        ctx.addIssue({ code: 'custom', path: ['fallbackRpcUrls', index], message: `duplicate of ${where}` });
      }
    });
  });

const configSchema = z
  .strictObject({
    version: z.literal(1, 'must equal 1'),
    network: networkSchema,
    pollIntervalMs: z
      .int()
      .min(MIN_POLL_INTERVAL_MS, `must be at least ${MIN_POLL_INTERVAL_MS}`)
      .max(MAX_POLL_INTERVAL_MS, `must be at most ${MAX_POLL_INTERVAL_MS} (one day)`)
      .optional(),
    maxStalenessMs: z.int().positive('must be a positive integer').optional(),
    contracts: z
      .record(z.string().regex(CONTRACT_NAME), contractSchema)
      .refine((contracts) => Object.keys(contracts).length > 0, 'must list at least one contract'),
  })
  .superRefine((config, ctx) => {
    if (config.maxStalenessMs === undefined) return;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const minimum = pollIntervalMs * MIN_STALENESS_FACTOR;
    if (config.maxStalenessMs < minimum) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxStalenessMs'],
        message: `must be at least ${MIN_STALENESS_FACTOR} times pollIntervalMs (${minimum})`,
      });
    }
  })
  .transform((config): WasmwardConfig => {
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const contracts: Record<string, ContractConfig> = {};
    for (const [name, contract] of Object.entries(config.contracts)) {
      contracts[name] = {
        contractId: contract.contractId,
        supported: contract.supported.map((version) =>
          version.label === undefined
            ? { wasmHash: version.wasmHash }
            : { wasmHash: version.wasmHash, label: version.label },
        ),
      };
    }
    return {
      version: 1,
      network: {
        rpcUrl: config.network.rpcUrl,
        fallbackRpcUrls: config.network.fallbackRpcUrls ?? [],
        passphrase: config.network.passphrase,
      },
      pollIntervalMs,
      maxStalenessMs: config.maxStalenessMs ?? pollIntervalMs * DEFAULT_STALENESS_FACTOR,
      contracts,
    };
  });

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Renders a zod issue path as a JSON path, for example `$.contracts.vault.supported[0].wasmHash`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '$';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      out += IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

const NETWORK_NAME = CONTRACT_NAME;

/**
 * A config file is either the original single-network shape, or a `networks` section that holds several
 * networks, each shaped like the original without `version`.
 */
export type ConfigDocument =
  | { kind: 'single'; config: WasmwardConfig }
  | { kind: 'multi'; networks: Record<string, WasmwardConfig> };

const multiSchema = z.strictObject({
  version: z.literal(1, 'must equal 1'),
  networks: z
    .record(z.string().regex(NETWORK_NAME), z.unknown())
    .refine((networks) => Object.keys(networks).length > 0, 'must list at least one network'),
});

interface RawIssue {
  path: readonly PropertyKey[];
  code: string;
  message: string;
}

function toIssues(issues: readonly RawIssue[], prefix: readonly PropertyKey[] = []): ConfigIssue[] {
  return issues.map((issue) => {
    const path = [...prefix, ...issue.path];
    let message = issue.message;
    if (issue.code === 'invalid_key') {
      // The only records are `networks` and `contracts`; the key's parent says which one was wrong.
      const kind = path[path.length - 2] === 'networks' ? 'network' : 'contract';
      message = `${kind} name must match ${CONTRACT_NAME.source}`;
    }
    return { path: formatPath(path), message };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeSource(source: string | undefined): string {
  return source === undefined ? '' : ` (in ${source})`;
}

/**
 * Validates a config of either shape. Works in every runtime. Throws {@link ConfigError} listing every
 * issue it can evaluate, across all networks, each with its JSON path. `options.source` names the file.
 */
export function loadConfigDocument(input: unknown, options: { source?: string } = {}): ConfigDocument {
  if (isPlainObject(input) && 'networks' in input) {
    const top = multiSchema.safeParse(input);
    const issues: ConfigIssue[] = top.success ? [] : toIssues(top.error.issues);
    const networks: Record<string, WasmwardConfig> = {};

    const entries = input['networks'];
    if (isPlainObject(entries)) {
      for (const [name, entry] of Object.entries(entries)) {
        if (!NETWORK_NAME.test(name)) continue; // already reported as a bad name
        if (!isPlainObject(entry)) {
          issues.push({ path: formatPath(['networks', name]), message: 'must be an object' });
          continue;
        }
        if (Object.hasOwn(entry, 'version')) {
          issues.push({
            path: formatPath(['networks', name, 'version']),
            message: 'must not be set here; the file has one version at the top',
          });
          continue;
        }
        const parsed = configSchema.safeParse({ ...entry, version: 1 });
        if (parsed.success) networks[name] = parsed.data;
        else issues.push(...toIssues(parsed.error.issues, ['networks', name]));
      }
    }
    if (issues.length > 0) throw ConfigError.fromIssues(issues, options.source);
    return { kind: 'multi', networks };
  }

  const result = configSchema.safeParse(input);
  if (!result.success) throw ConfigError.fromIssues(toIssues(result.error.issues), options.source);
  return { kind: 'single', config: result.data };
}

/**
 * Validates a config and returns one network's settings, with defaults applied and hashes lowercased.
 * Works in every runtime. Throws {@link ConfigError} listing every issue with its JSON path.
 *
 * For a file with a `networks` section you must say which one with `options.network`: choosing for you
 * could point an app at mainnet when it meant testnet. For a single-network file, `options.network`
 * is an error for the same reason. `options.source` names the file in error messages.
 */
export function loadConfig(input: unknown, options: { source?: string; network?: string } = {}): WasmwardConfig {
  const document = loadConfigDocument(input, options.source === undefined ? {} : { source: options.source });
  const where = describeSource(options.source);

  if (document.kind === 'single') {
    if (options.network !== undefined) {
      throw new ConfigError(
        `This config describes a single network, so network "${options.network}" cannot be chosen${where}.`,
      );
    }
    return document.config;
  }

  const names = Object.keys(document.networks);
  if (options.network === undefined) {
    throw new ConfigError(
      `This config describes ${names.length} networks (${names.join(', ')}); choose one, for example loadConfig(config, { network: "${names[0]}" })${where}.`,
    );
  }
  const chosen = Object.hasOwn(document.networks, options.network) ? document.networks[options.network] : undefined;
  if (chosen === undefined) {
    throw new ConfigError(`Unknown network "${options.network}". This config has: ${names.join(', ')}${where}.`);
  }
  return chosen;
}
