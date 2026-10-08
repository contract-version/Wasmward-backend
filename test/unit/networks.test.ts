import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, loadConfigDocument } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';
import { createVersionGuard } from '../../src/guard.js';
import { loadConfigDocumentFile, loadConfigFile } from '../../src/node.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';
const VAULT_TEST = contractIdOf(1);
const VAULT_MAIN = contractIdOf(2);
const H1 = hashOf(1);
const H2 = hashOf(2);

interface Contract {
  contractId: unknown;
  supported: unknown[];
}
interface Entry {
  network: { rpcUrl: unknown; fallbackRpcUrls?: unknown; passphrase: unknown };
  pollIntervalMs?: unknown;
  maxStalenessMs?: unknown;
  version?: unknown;
  surprise?: unknown;
  contracts: Record<string, Contract>;
}
interface Doc {
  version?: unknown;
  network?: unknown;
  contracts?: unknown;
  networks: Record<string, unknown>;
}

function entry(doc: Doc, name: string): Entry {
  const found = doc.networks[name];
  if (found === undefined) throw new Error('fixture has no network ' + name);
  return found as Entry;
}
function vault(doc: Doc, name: string): Contract {
  const found = entry(doc, name).contracts['vault'];
  if (found === undefined) throw new Error('fixture has no vault on ' + name);
  return found;
}

function multi(): Doc {
  return {
    version: 1,
    networks: {
      testnet: {
        network: { rpcUrl: 'https://rpc-test.example.org', passphrase: TESTNET },
        pollIntervalMs: 10_000,
        contracts: { vault: { contractId: VAULT_TEST, supported: [{ wasmHash: H1.toUpperCase(), label: 'v1' }] } },
      },
      mainnet: {
        network: { rpcUrl: 'https://rpc-main.example.org', fallbackRpcUrls: ['https://rpc-main-b.example.org'], passphrase: MAINNET },
        contracts: { vault: { contractId: VAULT_MAIN, supported: [{ wasmHash: H2 }] } },
      },
    },
  };
}

function mutate(change: (doc: Doc) => void): Doc {
  const doc = multi();
  change(doc);
  return doc;
}

function issuesOf(input: unknown): { path: string; message: string }[] {
  try {
    loadConfigDocument(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error('expected loadConfigDocument to throw');
}

describe('loadConfigDocument', () => {
  it('reads the original single-network shape unchanged', () => {
    const document = loadConfigDocument({
      version: 1,
      network: { rpcUrl: 'https://rpc.example.org', passphrase: TESTNET },
      contracts: { vault: { contractId: VAULT_TEST, supported: [{ wasmHash: H1 }] } },
    });
    expect(document.kind).toBe('single');
  });

  it('reads every network with its own defaults, hashes lowercased', () => {
    const document = loadConfigDocument(multi());
    expect(document.kind).toBe('multi');
    if (document.kind !== 'multi') return;
    expect(Object.keys(document.networks)).toEqual(['testnet', 'mainnet']);

    const testnet = document.networks['testnet'];
    expect(testnet?.network).toEqual({ rpcUrl: 'https://rpc-test.example.org', fallbackRpcUrls: [], passphrase: TESTNET });
    expect(testnet?.pollIntervalMs).toBe(10_000);
    expect(testnet?.maxStalenessMs).toBe(40_000);
    expect(testnet?.contracts['vault']?.supported[0]?.wasmHash).toBe(H1);

    const mainnet = document.networks['mainnet'];
    expect(mainnet?.pollIntervalMs).toBe(30_000);
    expect(mainnet?.maxStalenessMs).toBe(120_000);
    expect(mainnet?.network.fallbackRpcUrls).toEqual(['https://rpc-main-b.example.org']);
  });

  it('allows the same contract name on different networks', () => {
    const document = loadConfigDocument(multi());
    if (document.kind !== 'multi') throw new Error('expected multi');
    expect(document.networks['testnet']?.contracts['vault']?.contractId).not.toBe(
      document.networks['mainnet']?.contracts['vault']?.contractId,
    );
  });

  it('accepts a single network inside a networks section', () => {
    const doc = mutate((d) => delete d.networks['mainnet']);
    expect(loadConfigDocument(doc)).toMatchObject({ kind: 'multi' });
  });

  it('lists the problems of every network at once, with full paths', () => {
    const doc = mutate((d) => {
      entry(d, 'testnet').network.rpcUrl = 'http://public.example.org';
      vault(d, 'mainnet').contractId = 'nope';
    });
    const issues = issuesOf(doc);
    expect(issues).toContainEqual({ path: '$.networks.testnet.network.rpcUrl', message: expect.stringMatching(/https URL/) });
    expect(issues).toContainEqual({
      path: '$.networks.mainnet.contracts.vault.contractId',
      message: expect.stringMatching(/valid contract ID/),
    });
  });

  it('applies every single-network rule inside a network', () => {
    expect(
      issuesOf(mutate((d) => (entry(d, 'testnet').maxStalenessMs = 1_000))).map((issue) => issue.path),
    ).toContain('$.networks.testnet.maxStalenessMs');
    expect(
      issuesOf(mutate((d) => (entry(d, 'mainnet').network.fallbackRpcUrls = ['https://rpc-main.example.org']))),
    ).toContainEqual({ path: '$.networks.mainnet.network.fallbackRpcUrls[0]', message: 'duplicate of rpcUrl' });
    expect(
      issuesOf(mutate((d) => (vault(d, 'testnet').supported = []))).map((issue) => issue.path),
    ).toContain('$.networks.testnet.contracts.vault.supported');
    expect(
      issuesOf(mutate((d) => (entry(d, 'testnet').surprise = true))).some((issue) => issue.path === '$.networks.testnet'),
    ).toBe(true);
  });

  it('rejects a version inside a network, because the file has one', () => {
    const issues = issuesOf(mutate((d) => (entry(d, 'testnet').version = 1)));
    expect(issues).toContainEqual({
      path: '$.networks.testnet.version',
      message: expect.stringMatching(/must not be set here/),
    });
  });

  it('rejects a wrong top-level version', () => {
    expect(issuesOf(mutate((d) => (d.version = 2)))).toContainEqual({ path: '$.version', message: expect.stringMatching(/must equal 1/) });
  });

  it('rejects an empty networks section', () => {
    expect(issuesOf(mutate((d) => (d.networks = {})))).toContainEqual({
      path: '$.networks',
      message: expect.stringMatching(/at least one network/),
    });
  });

  it.each(['Testnet', '-test', 'has space', 'a'.repeat(65), ''])('rejects the network name %j', (name) => {
    const doc = mutate((d) => {
      d.networks = { [name]: entry(d, 'testnet') };
    });
    expect(issuesOf(doc).some((issue) => /network name must match/.test(issue.message))).toBe(true);
  });

  it('says network, not contract, for a bad network name', () => {
    const doc = mutate((d) => {
      d.networks = { Bad: entry(d, 'testnet') };
    });
    const messages = issuesOf(doc).map((issue) => issue.message);
    expect(messages.some((message) => message.startsWith('network name'))).toBe(true);
    expect(messages.some((message) => message.startsWith('contract name'))).toBe(false);
  });

  it('still says contract for a bad contract name inside a network', () => {
    const doc = mutate((d) => {
      entry(d, 'testnet').contracts = { Bad: vault(d, 'testnet') };
    });
    expect(issuesOf(doc)).toContainEqual({
      path: '$.networks.testnet.contracts.Bad',
      message: expect.stringMatching(/^contract name must match/),
    });
  });

  it('rejects a network that is not an object', () => {
    expect(issuesOf(mutate((d) => (d.networks['testnet'] = 'oops')))).toContainEqual({
      path: '$.networks.testnet',
      message: 'must be an object',
    });
  });

  it('rejects networks that is not an object', () => {
    expect(issuesOf({ version: 1, networks: ['testnet'] }).length).toBeGreaterThan(0);
  });

  it('rejects mixing the two shapes', () => {
    const doc = mutate((d) => {
      d.network = { rpcUrl: 'https://rpc.example.org', passphrase: TESTNET };
      d.contracts = {};
    });
    const issues = issuesOf(doc);
    expect(issues.some((issue) => issue.path === '$' && /network/.test(issue.message))).toBe(true);
  });

  it('names the file in the error', () => {
    try {
      loadConfigDocument(mutate((d) => (d.version = 3)), { source: 'wasmward.json' });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as ConfigError).message).toContain('in wasmward.json');
    }
  });
});

describe('loadConfig with networks', () => {
  it('returns the network you name', () => {
    expect(loadConfig(multi(), { network: 'testnet' }).network.passphrase).toBe(TESTNET);
    expect(loadConfig(multi(), { network: 'mainnet' }).network.passphrase).toBe(MAINNET);
  });

  it('never guesses: a multi-network file needs a network, and the error lists them', () => {
    expect(() => loadConfig(multi())).toThrow(ConfigError);
    expect(() => loadConfig(multi())).toThrow(/describes 2 networks \(testnet, mainnet\); choose one/);
  });

  it('rejects an unknown network and lists the real ones', () => {
    expect(() => loadConfig(multi(), { network: 'futurenet' })).toThrow(/Unknown network "futurenet". This config has: testnet, mainnet/);
  });

  it.each(['constructor', 'toString', '__proto__'])('does not find %s through inheritance', (name) => {
    expect(() => loadConfig(multi(), { network: name })).toThrow(/Unknown network/);
  });

  it('refuses a network choice for a single-network file, so a mistake is not silent', () => {
    const single = {
      version: 1,
      network: { rpcUrl: 'https://rpc.example.org', passphrase: TESTNET },
      contracts: { vault: { contractId: VAULT_TEST, supported: [{ wasmHash: H1 }] } },
    };
    expect(() => loadConfig(single, { network: 'mainnet' })).toThrow(/describes a single network, so network "mainnet" cannot be chosen/);
    expect(loadConfig(single).network.passphrase).toBe(TESTNET);
  });

  it('reports validation problems before network selection problems', () => {
    expect(() => loadConfig(mutate((d) => (d.version = 2)), { network: 'testnet' })).toThrow(/\$\.version/);
  });

  it('mentions the file when one is given', () => {
    expect(() => loadConfig(multi(), { source: 'wasmward.json' })).toThrow(/\(in wasmward.json\)/);
  });

  it('hands createVersionGuard a clear error when given the whole multi-network document', () => {
    expect(() => createVersionGuard(multi() as never)).toThrow(/describes 2 networks/);
  });

  it('works with a guard once a network is chosen', () => {
    const guard = createVersionGuard(loadConfig(multi(), { network: 'testnet' }));
    expect(guard.status()['vault']?.contractId).toBe(VAULT_TEST);
  });
});

describe('loading multi-network files', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wasmward-networks-'));
    file = join(dir, 'wasmward.json');
    await writeFile(file, JSON.stringify(multi()));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loadConfigFile loads the named network', async () => {
    const config = await loadConfigFile(file, { network: 'mainnet' });
    expect(config.network.passphrase).toBe(MAINNET);
    expect(config.contracts['vault']?.contractId).toBe(VAULT_MAIN);
  });

  it('loadConfigFile asks for a network instead of guessing', async () => {
    await expect(loadConfigFile(file)).rejects.toThrow(/choose one/);
  });

  it('loadConfigDocumentFile returns every network', async () => {
    const document = await loadConfigDocumentFile(file);
    expect(document.kind === 'multi' ? Object.keys(document.networks) : []).toEqual(['testnet', 'mainnet']);
  });

  it('names the file and the full path when a network is invalid', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify(mutate((d) => (entry(d, 'testnet').network.passphrase = ''))));
    const error = await loadConfigDocumentFile(bad).catch((caught: unknown) => caught);
    expect((error as ConfigError).message).toContain(`in ${bad}`);
    expect((error as ConfigError).issues.map((issue) => issue.path)).toContain('$.networks.testnet.network.passphrase');
  });
});
