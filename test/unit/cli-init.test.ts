import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main, type CliIo } from '../../src/cli-core.js';
import { loadConfig } from '../../src/config.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const MAINNET = 'Public Global Stellar Network ; September 2015';
const CONTRACT = contractIdOf(1);
const LIVE = hashOf(1);
const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5]);
const WASM_HASH = createHash('sha256').update(WASM).digest('hex');

let dir: string;
let chain: FakeChain;
let counter = 0;
let wasmFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-init-'));
  wasmFile = join(dir, 'build.wasm');
  await writeFile(wasmFile, WASM);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  chain = new FakeChain();
  chain.setWasm(CONTRACT, LIVE);
});

/** A config path that does not exist yet. */
function target(): string {
  counter += 1;
  return join(dir, `new-${counter}.json`);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], extra: Partial<CliIo> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    createServer: () => chain,
    now: () => 1_000_000,
    ...extra,
  });
  return { code, out, err };
}

const init = (config: string, ...args: string[]) => run(['init', 'vault', CONTRACT, '--config', config, ...args]);

describe('init from a Wasm file', () => {
  it('creates a valid config from the hash of the file, without touching the network', async () => {
    const config = target();
    const result = await init(config, '--preset', 'testnet', '--wasm', wasmFile, '--label', 'v1.0.0', '--wasm', wasmFile);
    expect(result.code).toBe(EXIT_OK);
    expect(chain.networkCalls).toBe(0);
    expect(chain.lookupCalls).toEqual([]);
    expect(result.out).toBe(`Created ${config}: 'vault' supports v1.0.0 (${WASM_HASH}), taken from ${wasmFile}.\n`);
    expect(result.err).toBe('');

    const written = await readFile(config, 'utf8');
    expect(JSON.parse(written)).toEqual({
      version: 1,
      network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: PASSPHRASE },
      contracts: { vault: { contractId: CONTRACT, supported: [{ wasmHash: WASM_HASH, label: 'v1.0.0' }] } },
    });
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
    expect(() => loadConfig(JSON.parse(written))).not.toThrow();
  });

  it('labels the first version "initial" by default', async () => {
    const config = target();
    await init(config, '--preset', 'testnet', '--wasm', wasmFile);
    expect(JSON.parse(await readFile(config, 'utf8')).contracts.vault.supported[0].label).toBe('initial');
  });

  it('prints JSON with --json', async () => {
    const config = target();
    const result = await init(config, '--preset', 'testnet', '--wasm', wasmFile, '--json');
    expect(JSON.parse(result.out)).toEqual({
      config,
      contract: 'vault',
      contractId: CONTRACT,
      wasmHash: WASM_HASH,
      label: 'initial',
      source: 'wasm-file',
    });
  });

  it('fails clearly when the Wasm file cannot be read, and writes nothing', async () => {
    const config = target();
    const result = await init(config, '--preset', 'testnet', '--wasm', join(dir, 'missing.wasm'));
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Cannot read');
    expect(existsSync(config)).toBe(false);
  });
});

describe('init from the network', () => {
  it('takes the live hash, warns that this trusts the RPC, and writes a config that checks clean', async () => {
    const config = target();
    const result = await init(config, '--preset', 'testnet');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toBe(`Created ${config}: 'vault' supports initial (${LIVE}), taken from the network.\n`);
    expect(result.err).toContain('trusts the RPC and whoever deployed it');
    expect(result.err).toContain('--wasm');
    expect(chain.networkCalls).toBe(1);
    expect(chain.lookupCalls).toEqual([1]);

    // The new file works with the rest of the tool: nothing more to configure.
    const check = await run(['check', '--config', config], { createFallbackServers: () => [] });
    expect(check.code).toBe(EXIT_OK);
    expect(check.out).toContain(`vault  supported (initial)  ${LIVE}`);
  });

  it('omits the warning from JSON output, which carries the source instead', async () => {
    const result = await init(target(), '--preset', 'testnet', '--json');
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toMatchObject({ source: 'network', wasmHash: LIVE });
  });

  it('uses the RPC address and passphrase it was given', async () => {
    chain.passphrase = 'Custom Network ; 2030';
    const config = target();
    const result = await init(config, '--rpc-url', 'https://rpc.example.org', '--passphrase', 'Custom Network ; 2030', '--label', 'first');
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(config, 'utf8')).network).toEqual({
      rpcUrl: 'https://rpc.example.org',
      passphrase: 'Custom Network ; 2030',
    });
  });

  it('lets --rpc-url replace the preset address', async () => {
    const config = target();
    await init(config, '--preset', 'testnet', '--rpc-url', 'https://my-rpc.example.org');
    expect(JSON.parse(await readFile(config, 'utf8')).network.rpcUrl).toBe('https://my-rpc.example.org');
  });

  it('works for mainnet when an RPC address is given', async () => {
    chain.passphrase = MAINNET;
    const config = target();
    const result = await init(config, '--preset', 'mainnet', '--rpc-url', 'https://mainnet-rpc.example.org');
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(config, 'utf8')).network.passphrase).toBe(MAINNET);
  });

  it.each([
    ['a contract that does not exist', (c: FakeChain) => c.remove(CONTRACT), /No contract with ID .* exists on this network/],
    ['an expired instance', (c: FakeChain) => (c.ttl = -1), /has expired \(archived\); restore it first/],
    ['a Stellar Asset Contract', (c: FakeChain) => c.setAsset(CONTRACT), /Stellar Asset Contract/],
    ['a failing lookup', (c: FakeChain) => (c.failLookups = new Error('rpc down')), /Could not read the live code of .*rpc down/],
    ['an unreachable RPC', (c: FakeChain) => (c.failNetwork = new Error('connection refused')), /connection refused/],
    ['an RPC serving another network', (c: FakeChain) => (c.passphrase = MAINNET), /serves network .* but the config expects/],
  ])('exits 2 and writes nothing for %s', async (_name, break_, message) => {
    break_(chain);
    const config = target();
    const result = await init(config, '--preset', 'testnet');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(message);
    expect(existsSync(config)).toBe(false);
  });

  it('validates the other settings before any network call', async () => {
    const config = target();
    const result = await run(['init', 'Bad Name', CONTRACT, '--preset', 'testnet', '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('contract name must match');
    expect(chain.networkCalls).toBe(0);
    expect(existsSync(config)).toBe(false);
  });
});

describe('init never overwrites', () => {
  it('refuses when the file exists, leaves it alone, and does no network work', async () => {
    const config = target();
    await writeFile(config, 'precious');
    const result = await init(config, '--preset', 'testnet');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('already exists. init never overwrites a file');
    expect(await readFile(config, 'utf8')).toBe('precious');
    expect(chain.networkCalls).toBe(0);
  });

  it('also refuses with --wasm', async () => {
    const config = target();
    await writeFile(config, 'precious');
    expect((await init(config, '--preset', 'testnet', '--wasm', wasmFile)).code).toBe(EXIT_ERROR);
    expect(await readFile(config, 'utf8')).toBe('precious');
  });

  it('lets exactly one of two simultaneous runs create the file', async () => {
    const config = target();
    const [a, b] = await Promise.all([
      init(config, '--preset', 'testnet', '--wasm', wasmFile, '--label', 'a'),
      init(config, '--preset', 'testnet', '--wasm', wasmFile, '--label', 'b'),
    ]);
    expect([a.code, b.code].sort()).toEqual([EXIT_OK, EXIT_ERROR]);
    const loser = a.code === EXIT_ERROR ? a : b;
    expect(loser.err).toContain('already exists');
    // The file is whole and loads: one run's content, never a mix.
    const written: unknown = JSON.parse(await readFile(config, 'utf8'));
    expect(() => loadConfig(written)).not.toThrow();
  });

  it('leaves no temporary file behind, on success or failure', async () => {
    await init(target(), '--preset', 'testnet', '--wasm', wasmFile);
    const exists = target();
    await writeFile(exists, 'x');
    await init(exists, '--preset', 'testnet', '--wasm', wasmFile);
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });
});

describe('init input checks', () => {
  it.each([[[]], [['vault']], [['vault', CONTRACT, 'extra']]])('exits 2 with usage for %j', async (positionals) => {
    const result = await run(['init', ...positionals, '--preset', 'testnet', '--config', target()]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage: wasmward init');
  });

  it('asks which network when none is given', async () => {
    const result = await init(target());
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Say which network');
  });

  it('asks for the passphrase when only an RPC address is given', async () => {
    const result = await init(target(), '--rpc-url', 'https://rpc.example.org');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Say which network');
  });

  it('needs an RPC address for the mainnet preset', async () => {
    const config = target();
    const result = await init(config, '--preset', 'mainnet');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('mainnet preset needs your own RPC endpoint');
    expect(existsSync(config)).toBe(false);
  });

  it('rejects an unknown preset and lists the real ones', async () => {
    const result = await init(target(), '--preset', 'futurenet');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown preset 'futurenet'. Choose one of: testnet, mainnet.");
  });

  it.each(['constructor', '__proto__'])('does not find the preset %s through inheritance', async (name) => {
    expect((await init(target(), '--preset', name)).err).toContain('Unknown preset');
  });

  it('rejects a passphrase that contradicts the preset', async () => {
    const result = await init(target(), '--preset', 'testnet', '--passphrase', MAINNET);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('does not match the testnet preset');
  });

  it('accepts the preset together with its own passphrase', async () => {
    expect((await init(target(), '--preset', 'testnet', '--passphrase', PASSPHRASE, '--wasm', wasmFile)).code).toBe(EXIT_OK);
  });

  it.each([
    ['an invalid contract ID', ['init', 'vault', 'C123', '--preset', 'testnet'], '$.contracts.vault.contractId'],
    ['a plain http RPC address on a public host', ['init', 'vault', CONTRACT, '--preset', 'testnet', '--rpc-url', 'http://rpc.example.org'], '$.network.rpcUrl'],
    ['a label that is too long', ['init', 'vault', CONTRACT, '--preset', 'testnet', '--label', 'x'.repeat(65)], 'at most 64'],
  ])('writes nothing for %s', async (_name, args, message) => {
    const config = target();
    const result = await run([...args, '--wasm', wasmFile, '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain(message);
    expect(existsSync(config)).toBe(false);
  });

  it('is listed in the usage text', async () => {
    let out = '';
    await main(['--help'], { stdout: (text) => (out += text), stderr: () => undefined });
    expect(out).toContain('wasmward init');
    expect(out).toContain('--preset');
    expect(out).toContain('--wasm <file>');
  });
});
