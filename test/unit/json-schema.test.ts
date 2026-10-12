import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { loadConfigDocument, MAX_FALLBACK_RPC_URLS, MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from '../../src/config.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

// The JSON Schema is for editors: it completes and checks the shape of wasmward.json. loadConfig is the authority.
// These tests keep the two from drifting: a file the schema rejects must be one loadConfig rejects, a file loadConfig
// accepts must pass the schema, and the few rules a schema cannot express are listed here, where they can be seen.

const schemaPath = new URL('../../schema/wasmward.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
const validate = new Ajv({ allErrors: true }).compile(schema);

const network = { rpcUrl: 'https://rpc.example.org', passphrase: 'Test SDF Network ; September 2015' };
const contract = { contractId: contractIdOf(1), supported: [{ wasmHash: hashOf(1), label: 'v1' }] };
const single = { version: 1, network, contracts: { vault: contract } };

/** Changes one thing in a deep copy of a valid single-network config. */
// The config is untyped on purpose: the cases below set things the real type forbids.
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function mutate(change: (config: Loose) => void): unknown {
  const copy: Loose = structuredClone(single);
  change(copy);
  return copy;
}

const accepted = (value: unknown): boolean => {
  try {
    loadConfigDocument(value);
    return true;
  } catch {
    return false;
  }
};

const VALID: [string, unknown][] = [
  ['the smallest single-network config', single],
  ['with a $schema pointer', { $schema: './node_modules/@wasmward/core/schema/wasmward.schema.json', ...single }],
  ['with every optional setting', mutate((c) => Object.assign(c, { pollIntervalMs: 10_000, maxStalenessMs: 40_000 }))],
  ['with fallbacks', mutate((c) => (c.network.fallbackRpcUrls = ['https://b.example.org', 'http://localhost:8000']))],
  ['with the most fallbacks allowed', mutate((c) => (c.network.fallbackRpcUrls = Array.from({ length: MAX_FALLBACK_RPC_URLS }, (_, i) => `https://rpc${i}.example.org`)))],
  ['with a local http RPC', mutate((c) => (c.network.rpcUrl = 'http://127.0.0.1:8000'))],
  ['with a hash in capitals', mutate((c) => (c.contracts.vault.supported[0].wasmHash = hashOf(1).toUpperCase()))],
  ['with a build that has no label', mutate((c) => delete c.contracts.vault.supported[0].label)],
  ['with a 64-character label', mutate((c) => (c.contracts.vault.supported[0].label = 'x'.repeat(64)))],
  ['with the lowest poll interval', mutate((c) => (c.pollIntervalMs = MIN_POLL_INTERVAL_MS))],
  ['with the highest poll interval', mutate((c) => Object.assign(c, { pollIntervalMs: MAX_POLL_INTERVAL_MS, maxStalenessMs: MAX_POLL_INTERVAL_MS * 2 }))],
  ['with a contract name using - and _', mutate((c) => (c.contracts = { 'my-vault_2': contract }))],
  [
    'with several networks',
    { version: 1, networks: { testnet: { network, contracts: { vault: contract } }, mainnet: { network: { ...network, rpcUrl: 'https://main.example.org' }, contracts: { pool: contract } } } },
  ],
  ['with several networks and a $schema pointer', { $schema: 'x', version: 1, networks: { testnet: { network, contracts: { vault: contract } } } }],
];

const INVALID: [string, unknown][] = [
  ['a version that is not 1', mutate((c) => (c.version = 2))],
  ['no version', mutate((c) => delete c.version)],
  ['no network', mutate((c) => delete c.network)],
  ['no contracts', mutate((c) => delete c.contracts)],
  ['an empty contracts section', mutate((c) => (c.contracts = {}))],
  ['an unknown top-level key', mutate((c) => (c.extra = true))],
  ['an unknown key in a network', mutate((c) => (c.network.extra = 1))],
  ['an unknown key in a contract', mutate((c) => (c.contracts.vault.extra = 1))],
  ['an unknown key in a build', mutate((c) => (c.contracts.vault.supported[0].extra = 1))],
  ['a plain http RPC that is not local', mutate((c) => (c.network.rpcUrl = 'http://rpc.example.org'))],
  ['an RPC URL that is not http or https', mutate((c) => (c.network.rpcUrl = 'ftp://rpc.example.org'))],
  ['an RPC URL that only starts like localhost', mutate((c) => (c.network.rpcUrl = 'http://localhost.evil.example'))],
  ['too many fallbacks', mutate((c) => (c.network.fallbackRpcUrls = Array.from({ length: MAX_FALLBACK_RPC_URLS + 1 }, (_, i) => `https://rpc${i}.example.org`)))],
  ['an empty passphrase', mutate((c) => (c.network.passphrase = ''))],
  ['a poll interval below the minimum', mutate((c) => (c.pollIntervalMs = MIN_POLL_INTERVAL_MS - 1))],
  ['a poll interval above one day', mutate((c) => (c.pollIntervalMs = MAX_POLL_INTERVAL_MS + 1))],
  ['a poll interval that is not a whole number', mutate((c) => (c.pollIntervalMs = 10_000.5))],
  ['a staleness of zero', mutate((c) => (c.maxStalenessMs = 0))],
  ['a contract name in capitals', mutate((c) => (c.contracts = { Vault: contract }))],
  ['a contract name starting with a dash', mutate((c) => (c.contracts = { '-vault': contract }))],
  ['a contract ID that is not an address', mutate((c) => (c.contracts.vault.contractId = 'not-an-id'))],
  ['an account address in place of a contract', mutate((c) => (c.contracts.vault.contractId = `G${contractIdOf(1).slice(1)}`))],
  ['no supported builds', mutate((c) => (c.contracts.vault.supported = []))],
  ['a hash that is too short', mutate((c) => (c.contracts.vault.supported[0].wasmHash = 'abc'))],
  ['a hash with a non-hex character', mutate((c) => (c.contracts.vault.supported[0].wasmHash = `g${hashOf(1).slice(1)}`))],
  ['an empty label', mutate((c) => (c.contracts.vault.supported[0].label = ''))],
  ['a label of 65 characters', mutate((c) => (c.contracts.vault.supported[0].label = 'x'.repeat(65)))],
  ['both network and networks', { version: 1, network, networks: { testnet: { network, contracts: { vault: contract } } }, contracts: { vault: contract } }],
  ['an empty networks section', { version: 1, networks: {} }],
  ['a network name in capitals', { version: 1, networks: { TestNet: { network, contracts: { vault: contract } } } }],
  ['a version inside a network', { version: 1, networks: { testnet: { version: 1, network, contracts: { vault: contract } } } }],
  ['a $schema inside a network', { version: 1, networks: { testnet: { $schema: 'x', network, contracts: { vault: contract } } } }],
  ['a network with no contracts', { version: 1, networks: { testnet: { network } } }],
  ['something that is not an object', []],
];

describe('wasmward.schema.json', () => {
  it('is a valid JSON Schema that says what it describes', () => {
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(typeof schema['title']).toBe('string');
    expect(typeof schema['$id']).toBe('string');
  });

  it.each(VALID)('accepts a config %s, as loadConfig does', (_name, value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(accepted(value)).toBe(true);
  });

  it.each(INVALID)('rejects %s, as loadConfig does', (_name, value) => {
    expect(validate(value)).toBe(false);
    expect(accepted(value)).toBe(false);
  });

  it('agrees with the limits in the code', () => {
    const definitions = schema['definitions'] as Record<string, Record<string, unknown>>;
    expect(definitions['pollIntervalMs']).toMatchObject({ minimum: MIN_POLL_INTERVAL_MS, maximum: MAX_POLL_INTERVAL_MS });
    const network = definitions['network']?.['properties'] as Record<string, Record<string, unknown>>;
    expect(network['fallbackRpcUrls']?.['maxItems']).toBe(MAX_FALLBACK_RPC_URLS);
  });

  // What a schema cannot say. The editor does not flag these; `wasmward validate` and loadConfig do.
  it.each([
    ['the same hash twice for one contract', mutate((c) => c.contracts.vault.supported.push({ wasmHash: hashOf(1) }))],
    ['a contract ID with a wrong checksum', mutate((c) => (c.contracts.vault.contractId = `${contractIdOf(1).slice(0, -1)}${contractIdOf(1).endsWith('A') ? 'B' : 'A'}`))],
    ['a staleness under twice the poll interval', mutate((c) => Object.assign(c, { pollIntervalMs: 10_000, maxStalenessMs: 15_000 }))],
    ['a fallback that repeats the primary', mutate((c) => (c.network.fallbackRpcUrls = [c.network.rpcUrl]))],
  ])('does not catch %s, which loadConfig does', (_name, value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(accepted(value)).toBe(false);
  });
});
