import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_NOT_SUPPORTED, EXIT_OK, main } from '../../src/cli-core.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const MAINNET = 'Public Global Stellar Network ; September 2015';
const VAULT_TEST = contractIdOf(1);
const VAULT_MAIN = contractIdOf(2);
const H1 = hashOf(1);
const H2 = hashOf(2);
const POLL = 5_000;
const ONE_POLL = POLL * 1.1;
const NEW_WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7]);

let dir: string;
let testnet: FakeChain;
let mainnet: FakeChain;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-networks-cli-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  testnet = new FakeChain();
  mainnet = new FakeChain();
  mainnet.passphrase = MAINNET;
  testnet.setWasm(VAULT_TEST, H1);
  mainnet.setWasm(VAULT_MAIN, H2);
});

afterEach(() => {
  vi.useRealTimers();
});

function document(): Record<string, unknown> {
  return {
    version: 1,
    networks: {
      testnet: {
        network: { rpcUrl: 'http://127.0.0.1:11', passphrase: PASSPHRASE },
        pollIntervalMs: POLL,
        contracts: { vault: { contractId: VAULT_TEST, supported: [{ wasmHash: H1, label: 'v1' }] } },
      },
      mainnet: {
        network: { rpcUrl: 'http://127.0.0.1:12', passphrase: MAINNET },
        pollIntervalMs: POLL,
        contracts: { vault: { contractId: VAULT_MAIN, supported: [{ wasmHash: H2, label: 'v1' }] } },
      },
    },
  };
}

async function fileOf(content: unknown, name = 'wasmward.json'): Promise<string> {
  counter += 1;
  const path = join(dir, `${counter}-${name}`);
  if (content instanceof Uint8Array || typeof content === 'string') await writeFile(path, content);
  else await writeFile(path, JSON.stringify(content, null, 2));
  return path;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], extra: Record<string, unknown> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    createServer: (config) => (config.network.rpcUrl.endsWith(':11') ? testnet : mainnet),
    createFallbackServers: () => [],
    now: () => 1_000_000,
    ...extra,
  });
  return { code, out, err };
}

describe('check with several networks', () => {
  it('checks every network when none is chosen, and exits 0 when all are supported', async () => {
    const result = await run(['check', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('== testnet ==');
    expect(result.out).toContain('== mainnet ==');
    expect(result.out).toContain(`Network: ${PASSPHRASE}`);
    expect(result.out).toContain(`Network: ${MAINNET}`);
    expect(result.out.indexOf('== testnet ==')).toBeLessThan(result.out.indexOf('== mainnet =='));
    expect(testnet.lookupCalls).toEqual([1]);
    expect(mainnet.lookupCalls).toEqual([1]);
  });

  it('exits 1 when any network has unsupported code, and still shows the others', async () => {
    mainnet.setWasm(VAULT_MAIN, H1);
    const result = await run(['check', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_NOT_SUPPORTED);
    expect(result.out).toMatch(/== testnet ==[\s\S]*supported \(v1\)[\s\S]*== mainnet ==[\s\S]*unsupported/);
  });

  it('exits 2 when one network cannot be reached, and still checks the other', async () => {
    mainnet.failNetwork = new Error('connection refused');
    const result = await run(['check', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.out).toContain('== mainnet ==\ncould not be checked: Could not verify the network: connection refused');
    expect(result.out).toMatch(/== testnet ==[\s\S]*1 of 1 contracts supported/);
    expect(result.err).toContain('could not be looked up');
  });

  it('lets 2 outrank 1', async () => {
    testnet.setWasm(VAULT_TEST, H2); // unsupported on testnet
    mainnet.failNetwork = new Error('down'); // unreachable on mainnet
    expect((await run(['check', '--config', await fileOf(document())])).code).toBe(EXIT_ERROR);
  });

  it('catches an RPC pointed at the wrong network: a mainnet URL that serves testnet', async () => {
    mainnet.passphrase = PASSPHRASE;
    const result = await run(['check', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.out).toContain('== mainnet ==\ncould not be checked:');
    expect(result.out).toContain(`config expects "${MAINNET}"`);
    expect(mainnet.lookupCalls).toEqual([]);
  });

  it('prints one JSON object with a report per network', async () => {
    const result = await run(['check', '--json', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_OK);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({ ok: true, exitCode: 0 });
    expect(Object.keys(json.networks)).toEqual(['testnet', 'mainnet']);
    expect(json.networks.testnet).toMatchObject({ ok: true, exitCode: 0, network: { passphrase: PASSPHRASE } });
    expect(json.networks.mainnet).toMatchObject({ ok: true, network: { passphrase: MAINNET } });
  });

  it('puts the failure of one network in the JSON without hiding the others', async () => {
    mainnet.failNetwork = new Error('offline');
    const result = await run(['check', '--json', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_ERROR);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({ ok: false, exitCode: 2 });
    expect(json.networks.testnet).toMatchObject({ ok: true });
    expect(json.networks.mainnet).toMatchObject({ ok: false, exitCode: 2, error: expect.stringContaining('offline') });
  });

  it('checks only the network you choose, printing it like a single-network check', async () => {
    const result = await run(['check', '--network', 'mainnet', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).not.toContain('==');
    expect(result.out).toContain(`Network: ${MAINNET}`);
    expect(testnet.lookupCalls).toEqual([]);
    expect(mainnet.lookupCalls).toEqual([1]);
  });

  it('gives a chosen network the top-level JSON shape', async () => {
    const result = await run(['check', '--network', 'testnet', '--json', '--config', await fileOf(document())]);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({ ok: true, exitCode: 0, network: { passphrase: PASSPHRASE } });
    expect(json).not.toHaveProperty('networks');
  });

  it('ends a chosen network that cannot be reached with exit 2 and a message', async () => {
    testnet.failNetwork = new Error('refused');
    const result = await run(['check', '--network', 'testnet', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('refused');
  });

  it('rejects an unknown network and lists the real ones', async () => {
    const result = await run(['check', '--network', 'futurenet', '--config', await fileOf(document())]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown network 'futurenet'. This config has: testnet, mainnet.");
  });

  it('rejects --network for a single-network file instead of ignoring it', async () => {
    const single = (document()['networks'] as Record<string, unknown>)['testnet'] as Record<string, unknown>;
    const file = await fileOf({ version: 1, ...single });
    const result = await run(['check', '--network', 'mainnet', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('describes a single network, so --network mainnet does not apply');
    expect(testnet.lookupCalls).toEqual([]);
  });

  it('still checks a single-network file exactly as before', async () => {
    const single = (document()['networks'] as Record<string, unknown>)['testnet'] as Record<string, unknown>;
    const result = await run(['check', '--config', await fileOf({ version: 1, ...single })]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).not.toContain('==');
  });

  it('reports an invalid network in the file with the full path, for every network', async () => {
    const bad = document();
    const testnetEntry = (bad['networks'] as Record<string, { network: { passphrase: string } }>)['testnet'];
    if (testnetEntry === undefined) throw new Error('fixture has no testnet');
    testnetEntry.network.passphrase = '';
    const result = await run(['check', '--config', await fileOf(bad)]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('$.networks.testnet.network.passphrase');
  });
});

describe('add with several networks', () => {
  async function wasm(): Promise<string> {
    return fileOf(NEW_WASM, 'new.wasm');
  }
  const sha = async (bytes: Uint8Array): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (b) => b.toString(16).padStart(2, '0')).join('');

  it('needs --network when there are several, and changes nothing without it', async () => {
    const file = await fileOf(document());
    const before = await readFile(file, 'utf8');
    const result = await run(['add', 'vault', await wasm(), '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('describes 2 networks (testnet, mainnet); choose one with --network <name>');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('adds to the chosen network only', async () => {
    const file = await fileOf(document());
    const result = await run(['add', 'vault', await wasm(), '--network', 'mainnet', '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toBe(`Added v2 (${await sha(NEW_WASM)}) to 'vault' on mainnet in ${file}\n`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.networks.mainnet.contracts.vault.supported).toEqual([
      { wasmHash: H2, label: 'v1' },
      { wasmHash: await sha(NEW_WASM), label: 'v2' },
    ]);
    expect(saved.networks.testnet.contracts.vault.supported).toEqual([{ wasmHash: H1, label: 'v1' }]);
  });

  it('keeps the file valid and its network order', async () => {
    const file = await fileOf(document());
    await run(['add', 'vault', await wasm(), '--network', 'testnet', '--label', 'v2', '--config', file]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(saved.networks)).toEqual(['testnet', 'mainnet']);
    const check = await run(['check', '--config', file]);
    expect(check.code).toBe(EXIT_OK);
  });

  it('allows the same hash on a different network, since each network has its own list', async () => {
    const file = await fileOf(document());
    const first = await run(['add', 'vault', await wasm(), '--network', 'testnet', '--label', 'v2', '--config', file]);
    const second = await run(['add', 'vault', await wasm(), '--network', 'mainnet', '--label', 'v2', '--config', file]);
    expect(first.code).toBe(EXIT_OK);
    expect(second.code).toBe(EXIT_OK);
  });

  it('refuses a duplicate on the same network and names it', async () => {
    const file = await fileOf(document());
    const wasmFile = await wasm();
    await run(['add', 'vault', wasmFile, '--network', 'mainnet', '--label', 'v2', '--config', file]);
    const again = await run(['add', 'vault', wasmFile, '--network', 'mainnet', '--label', 'v3', '--config', file]);
    expect(again.code).toBe(EXIT_ERROR);
    expect(again.err).toContain("is already supported for 'vault' on mainnet as 'v2'");
  });

  it('names the network when the contract is unknown there', async () => {
    const file = await fileOf(document());
    const result = await run(['add', 'pool', await wasm(), '--network', 'mainnet', '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown contract 'pool' on mainnet. Configured contracts: vault.");
  });

  it('rejects an unknown network', async () => {
    const file = await fileOf(document());
    const result = await run(['add', 'vault', await wasm(), '--network', 'nope', '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain("Unknown network 'nope'");
  });

  it('includes the network in JSON output', async () => {
    const file = await fileOf(document());
    const result = await run(['add', 'vault', await wasm(), '--network', 'testnet', '--label', 'v2', '--config', file, '--json']);
    expect(JSON.parse(result.out)).toMatchObject({ contract: 'vault', network: 'testnet', label: 'v2' });
  });

  it('works without --network when the file has exactly one network', async () => {
    const only = document();
    delete (only['networks'] as Record<string, unknown>)['mainnet'];
    const file = await fileOf(only);
    const result = await run(['add', 'vault', await wasm(), '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("to 'vault' on testnet");
  });

  it('rejects --network for a single-network file', async () => {
    const single = (document()['networks'] as Record<string, unknown>)['testnet'] as Record<string, unknown>;
    const file = await fileOf({ version: 1, ...single });
    const result = await run(['add', 'vault', await wasm(), '--network', 'testnet', '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('describes a single network');
  });

  it('refuses to write when the document is invalid in another network, and leaves it untouched', async () => {
    const bad = document();
    const mainnetEntry = (bad['networks'] as Record<string, { pollIntervalMs: number }>)['mainnet'];
    if (mainnetEntry === undefined) throw new Error('fixture has no mainnet');
    mainnetEntry.pollIntervalMs = 1;
    const file = await fileOf(bad);
    const before = await readFile(file, 'utf8');
    const result = await run(['add', 'vault', await wasm(), '--network', 'testnet', '--label', 'v2', '--config', file]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('$.networks.mainnet.pollIntervalMs');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('watch with several networks', () => {
  let stop: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    stop = new AbortController();
  });

  afterEach(() => {
    stop.abort();
  });

  function startWatch(file: string, args: string[] = []) {
    let out = '';
    let err = '';
    const done = main(['watch', '--config', file, ...args], {
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      createServer: (config) => (config.network.rpcUrl.endsWith(':11') ? testnet : mainnet),
      createFallbackServers: () => [],
      signal: stop.signal,
    });
    return { done, out: () => out, err: () => err };
  }

  it('asks which network to watch when there are several', async () => {
    const watch = startWatch(await fileOf(document()));
    await expect(watch.done).resolves.toBe(EXIT_ERROR);
    expect(watch.err()).toContain('describes 2 networks (testnet, mainnet); choose one with --network <name>');
    expect(testnet.lookupCalls).toEqual([]);
    expect(mainnet.lookupCalls).toEqual([]);
  });

  it('watches the chosen network and labels each line with it', async () => {
    const watch = startWatch(await fileOf(document()), ['--network', 'mainnet']);
    await vi.waitFor(() => expect(watch.out()).toContain('mainnet/vault: pending -> supported'));
    expect(watch.err()).toContain('Watching 1 contract(s) on mainnet.');
    expect(testnet.lookupCalls).toEqual([]);

    mainnet.setWasm(VAULT_MAIN, H1);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(watch.out()).toContain('mainnet/vault: supported -> unsupported');

    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('includes the network in JSON lines', async () => {
    const watch = startWatch(await fileOf(document()), ['--network', 'testnet', '--json']);
    await vi.waitFor(() => expect(watch.out().length).toBeGreaterThan(0));
    expect(JSON.parse(watch.out().split('\n')[0] ?? '')).toMatchObject({ network: 'testnet', contract: 'vault', to: 'supported' });
    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('uses the only network without being told', async () => {
    const only = document();
    delete (only['networks'] as Record<string, unknown>)['mainnet'];
    const watch = startWatch(await fileOf(only));
    await vi.waitFor(() => expect(watch.out()).toContain('testnet/vault: pending -> supported'));
    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('rejects an unknown network', async () => {
    const watch = startWatch(await fileOf(document()), ['--network', 'nope']);
    await expect(watch.done).resolves.toBe(EXIT_ERROR);
    expect(watch.err()).toContain("Unknown network 'nope'");
  });

  it('does not change how a single-network file is watched', async () => {
    const single = (document()['networks'] as Record<string, unknown>)['testnet'] as Record<string, unknown>;
    const watch = startWatch(await fileOf({ version: 1, ...single }));
    await vi.waitFor(() => expect(watch.out()).toContain(' vault: pending -> supported'));
    expect(watch.out()).not.toContain('testnet/vault');
    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });
});

describe('usage', () => {
  it('lists --network', async () => {
    let out = '';
    await main(['--help'], { stdout: (text) => (out += text), stderr: () => undefined });
    expect(out).toContain('--network <name>');
    expect(out).toContain('every network is checked');
  });
});
