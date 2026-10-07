import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { loadConfigFile } from '../../src/node.js';

const CONTRACT = StrKey.encodeContract(new Uint8Array(32).fill(3));
const HASH = 'c3'.repeat(32);
const VALID = JSON.stringify({
  version: 1,
  network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
  contracts: { vault: { contractId: CONTRACT, supported: [{ wasmHash: HASH.toUpperCase(), label: 'v1.0.0' }] } },
});

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-config-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('loadConfigFile', () => {
  it('loads and validates a JSON file, applying defaults and normalization', async () => {
    const config = await loadConfigFile(await write('ok.json', VALID));
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.contracts['vault']?.supported[0]?.wasmHash).toBe(HASH);
  });

  it('accepts a file that starts with a UTF-8 byte order mark', async () => {
    const config = await loadConfigFile(await write('bom.json', `\uFEFF${VALID}`));
    expect(config.contracts['vault']?.contractId).toBe(CONTRACT);
  });

  it('throws ConfigError naming the path when the file is missing', async () => {
    const path = join(dir, 'missing.json');
    const error = await loadConfigFile(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('Cannot read config file');
    expect((error as ConfigError).message).toContain(path);
  });

  it('throws ConfigError when the file is not JSON', async () => {
    const path = await write('bad.json', '{ not json');
    const error = await loadConfigFile(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('is not valid JSON');
    expect((error as ConfigError).message).toContain(path);
  });

  it('names the file in validation errors and keeps the issue list', async () => {
    const path = await write('invalid.json', JSON.stringify({ version: 2 }));
    const error = await loadConfigFile(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.message).toContain(`Invalid Wasmward config in ${path}`);
    expect(configError.issues.map((issue) => issue.path)).toContain('$.version');
  });
});
