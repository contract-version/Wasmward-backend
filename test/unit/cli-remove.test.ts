import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';
import { PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const network = { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE };
const vault = (supported: { wasmHash: string; label?: string }[]) => ({ contractId: contractIdOf(1), supported });
const V1 = { wasmHash: hashOf(1), label: 'v1' };
const V2 = { wasmHash: hashOf(2), label: 'v2' };

let dir: string;
let counter = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-remove-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileOf(content: unknown): Promise<string> {
  const path = join(dir, `config-${counter++}.json`);
  await writeFile(path, JSON.stringify(content, null, 2), 'utf8');
  return path;
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    createServer: () => {
      throw new Error('remove must not contact a network');
    },
  });
  return { code, out, err };
}

const single = (supported: { wasmHash: string; label?: string }[]) => ({ version: 1, network, contracts: { vault: vault(supported) } });
const supportedOf = async (path: string, contract = 'vault') =>
  (JSON.parse(await readFile(path, 'utf8')).contracts[contract].supported as { wasmHash: string; label?: string }[]);

describe('wasmward remove', () => {
  it('removes a build by its label and keeps the others', async () => {
    const path = await fileOf(single([V1, V2]));
    const result = await run(['remove', 'vault', 'v1', '--config', path]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(`Removed v1 (${hashOf(1)}) from 'vault'`);
    expect(await supportedOf(path)).toEqual([V2]);
  });

  it('removes a build by its hash, in either case', async () => {
    const path = await fileOf(single([V1, V2]));
    const result = await run(['remove', 'vault', hashOf(2).toUpperCase(), '--config', path]);
    expect(result.code).toBe(EXIT_OK);
    expect(await supportedOf(path)).toEqual([V1]);
  });

  it('removes a build whose hash is written in capitals in the file', async () => {
    const path = await fileOf(single([V1, { wasmHash: hashOf(2).toUpperCase(), label: 'v2' }]));
    expect((await run(['remove', 'vault', 'v2', '--config', path])).code).toBe(EXIT_OK);
    expect(await supportedOf(path)).toEqual([V1]);
  });

  it('refuses to remove the only build, and leaves the file as it was', async () => {
    const path = await fileOf(single([V1]));
    const before = await readFile(path, 'utf8');
    const result = await run(['remove', 'vault', 'v1', '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('only supported build');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('says what the contract does have when the label is unknown', async () => {
    const path = await fileOf(single([V1, V2]));
    const result = await run(['remove', 'vault', 'v9', '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("labelled 'v9'");
    expect(result.err).toContain('It has: v1, v2.');
  });

  it('says so when no build has that hash', async () => {
    const path = await fileOf(single([V1, V2]));
    const result = await run(['remove', 'vault', hashOf(7), '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('with that hash');
  });

  it('asks for the hash when two builds share a label', async () => {
    const path = await fileOf(single([V1, { wasmHash: hashOf(2), label: 'v1' }]));
    const before = await readFile(path, 'utf8');
    const result = await run(['remove', 'vault', 'v1', '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('remove one by its hash instead');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await run(['remove', 'vault', hashOf(2), '--config', path])).code).toBe(EXIT_OK);
    expect(await supportedOf(path)).toEqual([V1]);
  });

  it('can remove a build that has no label, by its hash', async () => {
    const path = await fileOf(single([V1, { wasmHash: hashOf(2) }]));
    const result = await run(['remove', 'vault', hashOf(2), '--json', '--config', path]);
    expect(result.code).toBe(EXIT_OK);
    const report = JSON.parse(result.out);
    expect(report).toEqual({ contract: 'vault', wasmHash: hashOf(2), config: path });
  });

  it('reports JSON with the label when there is one', async () => {
    const path = await fileOf(single([V1, V2]));
    const report = JSON.parse((await run(['remove', 'vault', 'v2', '--json', '--config', path])).out);
    expect(report).toEqual({ contract: 'vault', wasmHash: hashOf(2), label: 'v2', config: path });
  });

  it('names an unknown contract and lists the real ones', async () => {
    const result = await run(['remove', 'nope', 'v1', '--config', await fileOf(single([V1, V2]))]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown contract 'nope'");
    expect(result.err).toContain('vault');
  });

  it('does not treat an inherited object property as a contract', async () => {
    const result = await run(['remove', '__proto__', 'v1', '--config', await fileOf(single([V1, V2]))]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Unknown contract');
  });

  it('needs a contract and a build', async () => {
    const path = await fileOf(single([V1, V2]));
    for (const args of [['remove'], ['remove', 'vault'], ['remove', 'vault', 'v1', 'extra']]) {
      const result = await run([...args, '--config', path]);
      expect(result.code).toBe(EXIT_ERROR);
      expect(result.err).toContain('Usage: wasmward remove');
    }
  });

  it('works on a chosen network of a multi-network file and leaves the other alone', async () => {
    const document = {
      version: 1,
      networks: {
        testnet: { network, contracts: { vault: vault([V1, V2]) } },
        mainnet: { network: { ...network, rpcUrl: 'https://main.example.org' }, contracts: { vault: vault([V1, V2]) } },
      },
    };
    const path = await fileOf(document);
    const result = await run(['remove', 'vault', 'v1', '--network', 'testnet', '--config', path]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("from 'vault' on testnet");
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.networks.testnet.contracts.vault.supported).toEqual([V2]);
    expect(after.networks.mainnet.contracts.vault.supported).toEqual([V1, V2]);
  });

  it('will not guess the network when the file has several', async () => {
    const document = {
      version: 1,
      networks: {
        testnet: { network, contracts: { vault: vault([V1, V2]) } },
        mainnet: { network, contracts: { vault: vault([V1, V2]) } },
      },
    };
    const path = await fileOf(document);
    const before = await readFile(path, 'utf8');
    const result = await run(['remove', 'vault', 'v1', '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('choose one with --network');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('does not touch a config that is invalid', async () => {
    const path = join(dir, `broken-${counter++}.json`);
    await writeFile(path, '{ "version": 1 }', 'utf8');
    const result = await run(['remove', 'vault', 'v1', '--config', path]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(await readFile(path, 'utf8')).toBe('{ "version": 1 }');
  });

  it('is in the help text', async () => {
    expect((await run(['--help'])).out).toContain('wasmward remove <name> <label-or-hash>');
  });
});
