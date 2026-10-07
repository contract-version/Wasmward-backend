import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { ConfigError, type ConfigIssue } from './errors.js';
import type { ContractConfig, WasmwardConfig } from './types.js';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 5_000;
/** `maxStalenessMs` defaults to this many poll intervals. */
const DEFAULT_STALENESS_FACTOR = 4;
/** `maxStalenessMs` may not be smaller than this many poll intervals. */
const MIN_STALENESS_FACTOR = 2;

const CONTRACT_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const WASM_HASH = /^[0-9a-fA-F]{64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

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

const networkSchema = z.strictObject({
  rpcUrl: z
    .string()
    .refine(isAllowedRpcUrl, 'must be an https URL (http is allowed only for localhost or 127.0.0.1)'),
  passphrase: z.string().min(1, 'must not be empty'),
});

const configSchema = z
  .strictObject({
    version: z.literal(1, 'must equal 1'),
    network: networkSchema,
    pollIntervalMs: z.int().min(MIN_POLL_INTERVAL_MS, `must be at least ${MIN_POLL_INTERVAL_MS}`).optional(),
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
      network: { rpcUrl: config.network.rpcUrl, passphrase: config.network.passphrase },
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

/**
 * Validates a config object and returns it with defaults applied and hashes lowercased.
 * Works in every runtime. Throws {@link ConfigError} listing every issue with its JSON path.
 * `options.source` names the file the input came from and is added to the error message.
 */
export function loadConfig(input: unknown, options: { source?: string } = {}): WasmwardConfig {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    // `contracts` is the only record in the schema, so a bad key is always a bad contract name.
    message: issue.code === 'invalid_key' ? `contract name must match ${CONTRACT_NAME.source}` : issue.message,
  }));
  throw ConfigError.fromIssues(issues, options.source);
}
