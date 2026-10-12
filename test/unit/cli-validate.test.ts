import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';
import { PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const network = { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE };
const single = {
  version: 1,
  network,
  contracts: {
    vault: { contractId: contractIdOf(1), supported: [{ wasmHash: hashOf(1), label: 'v1' }, { wasmHash: hashOf(2), label: 'v2' }] },
    pool: { contractId: contractIdOf(2), supported: [{ wasmHash: hashOf(3), label: 'v1' }] },
  },
};
const multi = {
  version: 1,
  networks: {
    testnet: { network, contracts: { vault: single.contracts.vault } },
    mainnet: { network: { ...network, rpcUrl: 'https://main.example.org' }, contracts: { pool: single.contracts.pool } },
  },
};

let dir: string;
let counter = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-validate-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileOf(content: unknown): Promise<string> {
  const path = join(dir, `config-${counter++}.json`);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

/** `createServer` throws, so any attempt to reach a network fails the test. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    createServer: () => {
      throw new Error('validate must not contact a network');
    },
  });
  return { code, out, err };
}

describe('wasmward validate', () => {
  it('accepts a valid config and counts what is in it', async () => {
    const path = await fileOf(single);
    const result = await run(['validate', '--config', path]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('is valid: 1 network, 2 contracts.');
    expect(result.out).toContain('vault  2 supported builds');
    expect(result.out).toContain('pool  1 supported build\n');
    expect(result.err).toBe('');
  });

  it('lists each network of a multi-network config', async () => {
    const result = await run(['validate', '--config', await fileOf(multi)]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('2 networks, 2 contracts');
    expect(result.out).toMatch(/testnet:\n {2}vault {2}2 supported builds\n/);
    expect(result.out).toMatch(/mainnet:\n {2}pool/);
  });

  it('prints JSON with --json', async () => {
    const path = await fileOf(single);
    const report = JSON.parse((await run(['validate', '--json', '--config', path])).out);
    expect(report.ok).toBe(true);
    expect(report.config).toBe(path);
    expect(report.networks).toEqual([
      {
        rpcUrl: 'https://rpc.example.org',
        contracts: [
          { name: 'vault', contractId: contractIdOf(1), supported: 2 },
          { name: 'pool', contractId: contractIdOf(2), supported: 1 },
        ],
      },
    ]);
  });

  it('names each network in the JSON of a multi-network config', async () => {
    const report = JSON.parse((await run(['validate', '--json', '--config', await fileOf(multi)])).out);
    expect(report.networks.map((entry: { name: string }) => entry.name)).toEqual(['testnet', 'mainnet']);
  });

  it('exits 2 and says what is wrong with an invalid config', async () => {
    const bad = { ...single, contracts: { vault: { contractId: 'not-an-id', supported: [] } } };
    const result = await run(['validate', '--config', await fileOf(bad)]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('contracts.vault');
    expect(result.out).toBe('');
  });

  it('exits 2 with a JSON error for a file that is not JSON', async () => {
    const result = await run(['validate', '--json', '--config', await fileOf('{ nope')]);
    expect(result.code).toBe(EXIT_ERROR);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(false);
    expect(report.error).toContain('not valid JSON');
  });

  it('exits 2 for a file that does not exist', async () => {
    const result = await run(['validate', '--config', join(dir, 'missing.json')]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Cannot read config file');
  });

  it('accepts a file that starts with a byte order mark', async () => {
    const result = await run(['validate', '--config', await fileOf(`\uFEFF${JSON.stringify(single)}`)]);
    expect(result.code).toBe(EXIT_OK);
  });

  it('refuses extra arguments', async () => {
    const result = await run(['validate', 'extra', '--config', await fileOf(single)]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage: wasmward validate');
  });

  it('is in the help text', async () => {
    const result = await run(['--help']);
    expect(result.out).toContain('wasmward validate');
  });
});
