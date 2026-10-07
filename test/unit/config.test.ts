import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';

const CONTRACT_A = StrKey.encodeContract(new Uint8Array(32).fill(1));
const CONTRACT_B = StrKey.encodeContract(new Uint8Array(32).fill(2));
const HASH_1 = 'a1'.repeat(32);
const HASH_2 = 'b2'.repeat(32);

interface Version {
  wasmHash?: unknown;
  label?: unknown;
  hash?: unknown;
}
interface Contract {
  contractId?: unknown;
  supported?: Version[];
}
interface Doc {
  version?: unknown;
  network?: { rpcUrl?: unknown; passphrase?: unknown };
  pollIntervalMs?: unknown;
  maxStalenessMs?: unknown;
  pollIntervalMS?: unknown;
  contracts?: Record<string, Contract>;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error('fixture has no ' + what);
  return value;
}
const network = (c: Doc) => need(c.network, 'network');
const contracts = (c: Doc) => need(c.contracts, 'contracts');
const vault = (c: Doc): Contract => need(contracts(c)['vault'], 'vault');
const versions = (c: Doc): Version[] => need(vault(c).supported, 'supported list');
const firstVersion = (c: Doc): Version => need(versions(c)[0], 'first version');

function validConfig(): Doc {
  return {
    version: 1,
    network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
    contracts: {
      vault: { contractId: CONTRACT_A, supported: [{ wasmHash: HASH_1, label: 'v1.0.0' }] },
    },
  };
}

/** Applies a change to a fresh valid config and returns it. */
function mutate(change: (config: Doc) => void): Doc {
  const config = validConfig();
  change(config);
  return config;
}

function issuesOf(input: unknown): { path: string; message: string }[] {
  try {
    loadConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error('expected loadConfig to throw');
}

function expectIssue(input: unknown, path: string, message: RegExp): void {
  const issues = issuesOf(input);
  expect(issues, JSON.stringify(issues)).toContainEqual({ path, message: expect.stringMatching(message) });
}

describe('loadConfig: valid input', () => {
  it('accepts the documented shape and applies defaults', () => {
    expect(loadConfig(validConfig())).toEqual({
      version: 1,
      network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
      pollIntervalMs: 30_000,
      maxStalenessMs: 120_000,
      contracts: { vault: { contractId: CONTRACT_A, supported: [{ wasmHash: HASH_1, label: 'v1.0.0' }] } },
    });
  });

  it('defaults maxStalenessMs to four times a custom poll interval', () => {
    const config = loadConfig(mutate((c) => (c.pollIntervalMs = 10_000)));
    expect(config.pollIntervalMs).toBe(10_000);
    expect(config.maxStalenessMs).toBe(40_000);
  });

  it('keeps explicit intervals at the allowed minimums', () => {
    const config = loadConfig(
      mutate((c) => {
        c.pollIntervalMs = 5_000;
        c.maxStalenessMs = 10_000;
      }),
    );
    expect(config.pollIntervalMs).toBe(5_000);
    expect(config.maxStalenessMs).toBe(10_000);
  });

  it('lowercases uppercase hashes', () => {
    const config = loadConfig(mutate((c) => (firstVersion(c).wasmHash = HASH_1.toUpperCase())));
    expect(config.contracts['vault']?.supported[0]?.wasmHash).toBe(HASH_1);
  });

  it('allows a version with no label and omits the key', () => {
    const config = loadConfig(mutate((c) => (vault(c).supported = [{ wasmHash: HASH_1 }])));
    expect(config.contracts['vault']?.supported[0]).toStrictEqual({ wasmHash: HASH_1 });
  });

  it('accepts several contracts and several versions per contract', () => {
    const config = loadConfig(
      mutate((c) => {
        versions(c).push({ wasmHash: HASH_2 });
        contracts(c)['pool_2-x'] = { contractId: CONTRACT_B, supported: [{ wasmHash: HASH_2 }] };
      }),
    );
    expect(Object.keys(config.contracts)).toEqual(['vault', 'pool_2-x']);
    expect(config.contracts['vault']?.supported).toHaveLength(2);
  });

  it.each(['http://localhost:8000', 'http://127.0.0.1:8000/rpc', 'https://example.org'])(
    'accepts rpcUrl %s',
    (rpcUrl) => {
      expect(loadConfig(mutate((c) => (network(c).rpcUrl = rpcUrl))).network.rpcUrl).toBe(rpcUrl);
    },
  );

  it('accepts a 64 character contract name', () => {
    const name = 'a'.repeat(64);
    const config = loadConfig(
      mutate((c) => {
        c.contracts = { [name]: vault(c) };
      }),
    );
    expect(Object.keys(config.contracts)).toEqual([name]);
  });

  it('accepts a 64 character label', () => {
    expect(() => loadConfig(mutate((c) => (firstVersion(c).label = 'x'.repeat(64))))).not.toThrow();
  });
});

describe('loadConfig: invalid input', () => {
  it('rejects a non-object document', () => {
    expectIssue(null, '$', /./);
    expectIssue('config', '$', /./);
    expectIssue([], '$', /./);
  });

  it.each([2, '1', undefined])('rejects version %s', (version) => {
    expectIssue(mutate((c) => (c.version = version)), '$.version', /./);
  });

  it('explains a wrong version number', () => {
    expectIssue(mutate((c) => (c.version = 2)), '$.version', /must equal 1/);
  });

  it.each([
    ['http://soroban-testnet.stellar.org', 'plain http on a public host'],
    ['ftp://localhost', 'a non-http scheme'],
    ['not a url', 'a non-URL'],
    ['', 'an empty string'],
  ])('rejects rpcUrl %s (%s)', (rpcUrl) => {
    expectIssue(mutate((c) => (network(c).rpcUrl = rpcUrl)), '$.network.rpcUrl', /https URL/);
  });

  it('rejects an empty passphrase', () => {
    expectIssue(mutate((c) => (network(c).passphrase = '')), '$.network.passphrase', /not be empty/);
  });

  it('rejects a missing network', () => {
    expectIssue(mutate((c) => delete c.network), '$.network', /./);
  });

  it.each([4_999, 0, -1, 30_000.5])('rejects pollIntervalMs %s', (value) => {
    expectIssue(mutate((c) => (c.pollIntervalMs = value)), '$.pollIntervalMs', /./);
  });

  it('rejects maxStalenessMs below twice the default poll interval', () => {
    expectIssue(
      mutate((c) => (c.maxStalenessMs = 59_999)),
      '$.maxStalenessMs',
      /at least 2 times pollIntervalMs \(60000\)/,
    );
  });

  it('rejects maxStalenessMs below twice a custom poll interval', () => {
    const input = mutate((c) => {
      c.pollIntervalMs = 10_000;
      c.maxStalenessMs = 19_999;
    });
    expectIssue(input, '$.maxStalenessMs', /\(20000\)/);
  });

  it('rejects a non-positive maxStalenessMs', () => {
    expectIssue(mutate((c) => (c.maxStalenessMs = 0)), '$.maxStalenessMs', /positive/);
  });

  it('rejects an empty contracts object', () => {
    expectIssue(mutate((c) => (c.contracts = {})), '$.contracts', /at least one contract/);
  });

  it('rejects missing contracts', () => {
    expectIssue(mutate((c) => delete c.contracts), '$.contracts', /./);
  });

  it.each(['Vault', '-vault', '_vault', 'has space', 'a'.repeat(65), ''])('rejects contract name %j', (name) => {
    const issues = issuesOf(
      mutate((c) => {
        c.contracts = { [name]: vault(c) };
      }),
    );
    expect(
      issues.some((issue) => /name must match/.test(issue.message)),
      JSON.stringify(issues),
    ).toBe(true);
  });

  it.each(['', 'C', 'nope', StrKey.encodeContract(new Uint8Array(32)).slice(0, -1), `G${CONTRACT_A.slice(1)}`])(
    'rejects contract ID %j',
    (id) => {
      expectIssue(mutate((c) => (vault(c).contractId = id)), '$.contracts.vault.contractId', /valid contract ID/);
    },
  );

  it('rejects a contract with no supported versions', () => {
    expectIssue(
      mutate((c) => (vault(c).supported = [])),
      '$.contracts.vault.supported',
      /at least one supported version/,
    );
  });

  it('rejects a missing supported list', () => {
    expectIssue(mutate((c) => delete vault(c).supported), '$.contracts.vault.supported', /./);
  });

  it.each(['abc', 'g'.repeat(64), HASH_1.slice(1), `${HASH_1}0`, ''])('rejects wasmHash %j', (hash) => {
    expectIssue(
      mutate((c) => (firstVersion(c).wasmHash = hash)),
      '$.contracts.vault.supported[0].wasmHash',
      /64 hex characters/,
    );
  });

  it('rejects duplicate hashes, including ones that differ only by case', () => {
    const input = mutate((c) => {
      vault(c).supported = [{ wasmHash: HASH_1 }, { wasmHash: HASH_2 }, { wasmHash: HASH_1.toUpperCase() }];
    });
    expectIssue(input, '$.contracts.vault.supported[2].wasmHash', /duplicate of supported\[0\]/);
  });

  it('allows the same hash in different contracts', () => {
    expect(() =>
      loadConfig(mutate((c) => (contracts(c).other = { contractId: CONTRACT_B, supported: [{ wasmHash: HASH_1 }] }))),
    ).not.toThrow();
  });

  it('rejects an empty label', () => {
    expectIssue(
      mutate((c) => (firstVersion(c).label = '')),
      '$.contracts.vault.supported[0].label',
      /not be empty/,
    );
  });

  it('rejects a label over 64 characters', () => {
    expectIssue(
      mutate((c) => (firstVersion(c).label = 'x'.repeat(65))),
      '$.contracts.vault.supported[0].label',
      /at most 64/,
    );
  });

  it('rejects unknown keys so typos are not silently ignored', () => {
    expectIssue(mutate((c) => (c.pollIntervalMS = 10_000)), '$', /pollIntervalMS/);
    expectIssue(mutate((c) => (firstVersion(c).hash = HASH_2)), '$.contracts.vault.supported[0]', /hash/);
  });
});

describe('ConfigError', () => {
  it('lists every issue with its JSON path in the message', () => {
    const input = mutate((c) => {
      c.version = 2;
      network(c).rpcUrl = 'http://example.org';
      firstVersion(c).wasmHash = 'zz';
    });
    let error: unknown;
    try {
      loadConfig(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.name).toBe('ConfigError');
    expect(configError.issues).toHaveLength(3);
    expect(configError.message).toContain('$.version');
    expect(configError.message).toContain('$.network.rpcUrl');
    expect(configError.message).toContain('$.contracts.vault.supported[0].wasmHash');
  });

  it('quotes path segments that are not plain identifiers', () => {
    const issues = issuesOf(
      mutate((c) => {
        c.contracts = { 'Bad Name': vault(c) };
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain('$.contracts["Bad Name"]');
  });

  it('can carry a message without issues', () => {
    const error = new ConfigError('network mismatch');
    expect(error.issues).toEqual([]);
    expect(error.message).toBe('network mismatch');
    expect(error).toBeInstanceOf(Error);
  });
});
