import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_NOT_SUPPORTED, EXIT_OK, main, type CliIo } from '../../src/cli-core.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const POOL = contractIdOf(2);
const V1 = hashOf(1);
const V2 = hashOf(2);
const WASM_A = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1]);
const WASM_B = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2]);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let dir: string;
let chain: FakeChain;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-cli-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
});

afterEach(() => {
  vi.useRealTimers();
});

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

let counter = 0;
async function fileIn(name: string, content: string | Uint8Array): Promise<string> {
  counter += 1;
  const path = join(dir, `${counter}-${name}`);
  await writeFile(path, content);
  return path;
}

function baseConfig(): Record<string, unknown> {
  return {
    version: 1,
    network: { rpcUrl: 'http://127.0.0.1:9', passphrase: PASSPHRASE },
    contracts: {
      vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] },
    },
  };
}

async function configFile(config: unknown = baseConfig()): Promise<string> {
  return fileIn('wasmward.json', JSON.stringify(config, null, 2));
}

describe('usage', () => {
  it('prints usage to stderr and exits 2 with no command', async () => {
    const result = await run([]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage:');
    expect(result.out).toBe('');
  });

  it.each([['--help'], ['-h'], ['hash', '--help']])('prints usage to stdout and exits 0 for %j', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('wasmward check');
    expect(result.out).toContain('Exit codes');
  });

  it('rejects an unknown command', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown command 'frobnicate'");
  });

  it('rejects an unknown option', async () => {
    const result = await run(['check', '--nope']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('--nope');
  });

  it('reports errors as JSON on stdout with --json', async () => {
    const result = await run(['frobnicate', '--json']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, exitCode: 2, error: expect.stringContaining('Unknown command') });
  });
});

describe('hash', () => {
  it('prints the lowercase SHA-256 of the file', async () => {
    const file = await fileIn('a.wasm', WASM_A);
    const result = await run(['hash', file]);
    expect(result).toEqual({ code: EXIT_OK, out: `${sha256(WASM_A)}\n`, err: '' });
  });

  it('prints JSON with --json', async () => {
    const file = await fileIn('a.wasm', WASM_A);
    const result = await run(['hash', file, '--json']);
    expect(JSON.parse(result.out)).toEqual({ file, wasmHash: sha256(WASM_A) });
  });

  it('exits 2 when the file is unreadable', async () => {
    const result = await run(['hash', join(dir, 'nope.wasm')]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Cannot read');
  });

  it.each([[[]], [['a', 'b']]])('exits 2 for the wrong number of files: %j', async (files) => {
    const result = await run(['hash', ...files]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage: wasmward hash');
  });
});

describe('add', () => {
  it('appends the hash and label, keeping the file readable and stable', async () => {
    const config = await configFile();
    const wasm = await fileIn('b.wasm', WASM_B);
    const result = await run(['add', 'vault', wasm, '--label', 'v1.1.0', '--config', config]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toBe(`Added v1.1.0 (${sha256(WASM_B)}) to 'vault' in ${config}\n`);

    const written = await readFile(config, 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written).contracts.vault.supported).toEqual([
      { wasmHash: V1, label: 'v1.0.0' },
      { wasmHash: sha256(WASM_B), label: 'v1.1.0' },
    ]);
    // Formatted with two spaces, and unchanged when written again from its own parsed content.
    expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  });

  it('does not add defaults, and keeps the original key order', async () => {
    const config = await fileIn(
      'ordered.json',
      JSON.stringify({ contracts: baseConfig()['contracts'], network: baseConfig()['network'], version: 1 }),
    );
    await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--label', 'v2', '--config', config]);
    const parsed = JSON.parse(await readFile(config, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['contracts', 'network', 'version']);
  });

  it('prints JSON with --json', async () => {
    const config = await configFile();
    const wasm = await fileIn('b.wasm', WASM_B);
    const result = await run(['add', 'vault', wasm, '--label', 'v2', '--config', config, '--json']);
    expect(JSON.parse(result.out)).toEqual({ contract: 'vault', wasmHash: sha256(WASM_B), label: 'v2', config });
  });

  it('can be used again, and the second hash is added after the first', async () => {
    const config = await configFile();
    await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--label', 'v2', '--config', config]);
    const third = new Uint8Array([9, 9, 9]);
    const result = await run(['add', 'vault', await fileIn('c.wasm', third), '--label', 'v3', '--config', config]);
    expect(result.code).toBe(EXIT_OK);
    const labels = JSON.parse(await readFile(config, 'utf8')).contracts.vault.supported.map((v: { label: string }) => v.label);
    expect(labels).toEqual(['v1.0.0', 'v2', 'v3']);
  });

  it('refuses a duplicate and leaves the file untouched', async () => {
    const config = await configFile();
    const before = await readFile(config, 'utf8');
    const wasm = await fileIn('a.wasm', WASM_B);
    await run(['add', 'vault', wasm, '--label', 'v2', '--config', config]);
    const afterFirst = await readFile(config, 'utf8');
    const again = await run(['add', 'vault', wasm, '--label', 'v2-again', '--config', config]);
    expect(again.code).toBe(EXIT_ERROR);
    expect(again.err).toContain('already supported');
    expect(again.err).toContain("as 'v2'");
    expect(await readFile(config, 'utf8')).toBe(afterFirst);
    expect(afterFirst).not.toBe(before);
  });

  it('treats an uppercase hash already in the file as a duplicate', async () => {
    const upper = sha256(WASM_A).toUpperCase();
    const config = await configFile({
      ...baseConfig(),
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: upper }] } },
    });
    const result = await run(['add', 'vault', await fileIn('a.wasm', WASM_A), '--label', 'again', '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('already supported');
  });

  it('exits 2 for an unknown contract', async () => {
    const config = await configFile();
    const result = await run(['add', 'nope', await fileIn('a.wasm', WASM_A), '--label', 'x', '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown contract 'nope'");
    expect(result.err).toContain('vault');
  });

  it.each(['constructor', '__proto__'])('does not find %s through inheritance', async (name) => {
    const config = await configFile();
    const result = await run(['add', name, await fileIn('a.wasm', WASM_A), '--label', 'x', '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Unknown contract');
  });

  it('requires --label', async () => {
    const config = await configFile();
    const result = await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('--label is required');
  });

  it.each([[['vault']], [['vault', 'a', 'b']], [[]]])('exits 2 for the wrong positionals: %j', async (positionals) => {
    const result = await run(['add', ...positionals, '--label', 'x']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage: wasmward add');
  });

  it('exits 2 when the wasm file is unreadable, leaving the config alone', async () => {
    const config = await configFile();
    const before = await readFile(config, 'utf8');
    const result = await run(['add', 'vault', join(dir, 'missing.wasm'), '--label', 'x', '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Cannot read');
    expect(await readFile(config, 'utf8')).toBe(before);
  });

  it('exits 2 for a missing or invalid config without writing anything', async () => {
    const wasm = await fileIn('b.wasm', WASM_B);
    const missing = await run(['add', 'vault', wasm, '--label', 'x', '--config', join(dir, 'absent.json')]);
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err).toContain('Cannot read config file');

    const invalid = await configFile({ version: 2 });
    const before = await readFile(invalid, 'utf8');
    const result = await run(['add', 'vault', wasm, '--label', 'x', '--config', invalid]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('$.version');
    expect(await readFile(invalid, 'utf8')).toBe(before);

    const notJson = await fileIn('broken.json', '{ nope');
    expect((await run(['add', 'vault', wasm, '--label', 'x', '--config', notJson])).err).toContain('not valid JSON');
  });

  it('validates the result before writing, so a bad label never reaches the file', async () => {
    const config = await configFile();
    const before = await readFile(config, 'utf8');
    const result = await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--label', 'x'.repeat(65), '--config', config]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('at most 64');
    expect(await readFile(config, 'utf8')).toBe(before);
    expect(await readdir(dir)).not.toContainEqual(expect.stringContaining('.wasmward.tmp'));
  });

  it('accepts a config that begins with a byte order mark', async () => {
    const bom = String.fromCharCode(0xfeff);
    const config = await fileIn('bom.json', `${bom}${JSON.stringify(baseConfig())}`);
    const result = await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--label', 'v2', '--config', config]);
    expect(result.code).toBe(EXIT_OK);
    expect((await readFile(config, 'utf8')).startsWith(bom)).toBe(false);
  });

  it('leaves no temporary files behind after a successful write', async () => {
    const config = await configFile();
    await run(['add', 'vault', await fileIn('b.wasm', WASM_B), '--label', 'v2', '--config', config]);
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });
});

describe('check', () => {
  it('exits 0 when every contract is supported', async () => {
    const config = await configFile();
    const result = await run(['check', '--config', config]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(`Network: ${PASSPHRASE}`);
    expect(result.out).toContain(`vault  supported (v1.0.0)  ${V1}`);
    expect(result.out).toContain('1 of 1 contracts supported.');
    expect(chain.lookupCalls).toEqual([1]);
  });

  it('exits 1 when a contract runs unsupported code, naming the hash', async () => {
    chain.setWasm(VAULT, V2);
    const result = await run(['check', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_NOT_SUPPORTED);
    expect(result.out).toContain(`vault  unsupported: live code ${V2} is not in the supported list`);
    expect(result.out).toContain('0 of 1 contracts supported.');
  });

  it('exits 1 for a missing contract', async () => {
    chain.remove(VAULT);
    const result = await run(['check', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_NOT_SUPPORTED);
    expect(result.out).toContain('missing');
  });

  it('exits 1 if any one contract is not supported, and lists them all in one lookup', async () => {
    chain.setWasm(POOL, V2);
    const config = baseConfig() as { contracts: Record<string, unknown> };
    config.contracts['pool'] = { contractId: POOL, supported: [{ wasmHash: V1 }] };
    const result = await run(['check', '--config', await configFile(config)]);
    expect(result.code).toBe(EXIT_NOT_SUPPORTED);
    expect(result.out).toContain('vault  supported');
    expect(result.out).toContain('pool   unsupported');
    expect(result.out).toContain('1 of 2 contracts supported.');
    expect(chain.lookupCalls).toEqual([2]);
  });

  it('exits 2, not 1, when a lookup fails', async () => {
    chain.failLookups = new Error('rpc down');
    const result = await run(['check', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.out).toContain('rpc down');
    expect(result.err).toContain('could not be looked up');
  });

  it('exits 2 when the RPC serves a different network', async () => {
    chain.passphrase = 'Public Global Stellar Network ; September 2015';
    const result = await run(['check', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Public Global Stellar Network');
    expect(chain.lookupCalls).toEqual([]);
  });

  it('exits 2 when the RPC cannot be reached', async () => {
    chain.failNetwork = new Error('connection refused');
    const result = await run(['check', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('connection refused');
  });

  it('exits 2 when the network check hangs past the timeout', async () => {
    vi.useFakeTimers();
    const hanging = { getNetwork: () => new Promise<never>(() => undefined), getLedgerEntries: chain.getLedgerEntries };
    const pending = run(['check', '--config', await configFile({ ...baseConfig(), pollIntervalMs: 5_000 })], {
      createServer: () => hanging,
    });
    // The config file is read with real I/O first; wait until the CLI has armed its timeout.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('getNetwork timed out after 5000ms');
  });

  it('exits 2 for a missing or invalid config', async () => {
    const missing = await run(['check', '--config', join(dir, 'absent.json')]);
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err).toContain('Cannot read config file');
    const invalid = await run(['check', '--config', await configFile({ version: 2 })]);
    expect(invalid.code).toBe(EXIT_ERROR);
    expect(invalid.err).toContain('$.version');
  });

  it('rejects extra arguments', async () => {
    const result = await run(['check', 'vault']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Usage: wasmward check');
  });

  it('prints a JSON report with --json and the exit code', async () => {
    chain.setWasm(VAULT, V2);
    const result = await run(['check', '--json', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_NOT_SUPPORTED);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      ok: false,
      exitCode: 1,
      network: { passphrase: PASSPHRASE, verified: true },
      contracts: { vault: { contractId: VAULT, status: 'unsupported', writable: false, liveWasmHash: V2 } },
    });
    expect(result.err).toBe('');
  });

  it('prints ok: true in JSON when everything is supported', async () => {
    const result = await run(['check', '--json', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.out)).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('reports a failed lookup in JSON with exit code 2', async () => {
    chain.failLookups = new Error('rpc down');
    const result = await run(['check', '--json', '--config', await configFile()]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, exitCode: 2, contracts: { vault: { lastError: 'rpc down' } } });
  });

  it('reports a config error in JSON on stdout', async () => {
    const result = await run(['check', '--json', '--config', join(dir, 'absent.json')]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('builds its own RPC client by default', async () => {
    const config = await configFile({ ...baseConfig(), network: { rpcUrl: 'http://127.0.0.1:1', passphrase: PASSPHRASE } });
    const result = await main(['check', '--config', config], { stdout: () => undefined, stderr: () => undefined });
    expect(result).toBe(EXIT_ERROR);
  });
});
