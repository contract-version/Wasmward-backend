import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_NOT_SUPPORTED, EXIT_OK, main } from '../../src/cli-core.js';
import { loadConfig, MAX_FALLBACK_RPC_URLS } from '../../src/config.js';
import { ConfigError, WriteBlockedError } from '../../src/errors.js';
import { createVersionGuard, type StatusChange } from '../../src/guard.js';
import type { WasmwardConfigInput } from '../../src/types.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const V2 = hashOf(2);
const POLL = 5_000;
const ONE_POLL = POLL * 1.1;
const CONTRACT = VAULT;

function configInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    network: { rpcUrl: 'https://primary.example.org', passphrase: PASSPHRASE, ...extra },
    contracts: { vault: { contractId: CONTRACT, supported: [{ wasmHash: V1 }] } },
  };
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

describe('config: fallbackRpcUrls', () => {
  it('defaults to an empty list', () => {
    expect(loadConfig(configInput()).network.fallbackRpcUrls).toEqual([]);
  });

  it('keeps the listed URLs in order', () => {
    const urls = ['https://b.example.org', 'http://localhost:8000', 'http://127.0.0.1:9000/rpc'];
    expect(loadConfig(configInput({ fallbackRpcUrls: urls })).network.fallbackRpcUrls).toEqual(urls);
  });

  it('accepts exactly the maximum number of fallbacks', () => {
    const urls = Array.from({ length: MAX_FALLBACK_RPC_URLS }, (_, i) => `https://f${i}.example.org`);
    expect(() => loadConfig(configInput({ fallbackRpcUrls: urls }))).not.toThrow();
  });

  it('rejects more than the maximum', () => {
    const urls = Array.from({ length: MAX_FALLBACK_RPC_URLS + 1 }, (_, i) => `https://f${i}.example.org`);
    expect(issuesOf(configInput({ fallbackRpcUrls: urls }))).toContainEqual({
      path: '$.network.fallbackRpcUrls',
      message: `must list at most ${MAX_FALLBACK_RPC_URLS} URLs`,
    });
  });

  it.each(['http://public.example.org', 'not a url', ''])('applies the https rule to a fallback: %j', (url) => {
    expect(issuesOf(configInput({ fallbackRpcUrls: ['https://ok.example.org', url] }))).toContainEqual({
      path: '$.network.fallbackRpcUrls[1]',
      message: expect.stringMatching(/https URL/),
    });
  });

  it.each([
    ['the same URL', 'https://primary.example.org'],
    ['a different case in the host', 'https://PRIMARY.example.org'],
    ['a trailing slash', 'https://primary.example.org/'],
    ['the default port', 'https://primary.example.org:443'],
  ])('rejects a fallback that repeats the primary (%s)', (_name, url) => {
    expect(issuesOf(configInput({ fallbackRpcUrls: [url] }))).toContainEqual({
      path: '$.network.fallbackRpcUrls[0]',
      message: 'duplicate of rpcUrl',
    });
  });

  it('rejects a repeated fallback', () => {
    expect(issuesOf(configInput({ fallbackRpcUrls: ['https://a.example.org', 'https://a.example.org/'] }))).toContainEqual({
      path: '$.network.fallbackRpcUrls[1]',
      message: 'duplicate of fallbackRpcUrls[0]',
    });
  });

  it('allows different paths on one host', () => {
    expect(() =>
      loadConfig(configInput({ rpcUrl: 'https://rpc.example.org/a', fallbackRpcUrls: ['https://rpc.example.org/b'] })),
    ).not.toThrow();
  });

  it('rejects a fallback list that is not an array', () => {
    expect(issuesOf(configInput({ fallbackRpcUrls: 'https://a.example.org' })).map((issue) => issue.path)).toContain(
      '$.network.fallbackRpcUrls',
    );
  });
});

describe('guard with fallback endpoints', () => {
  let primary: FakeChain;
  let fallback: FakeChain;

  const config = (): WasmwardConfigInput => ({
    version: 1,
    network: { rpcUrl: 'https://primary.example.org', fallbackRpcUrls: ['https://fallback.example.org'], passphrase: PASSPHRASE },
    pollIntervalMs: POLL,
    maxStalenessMs: 30_000,
    contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
  });

  const guards: ReturnType<typeof createVersionGuard>[] = [];
  const make = (input: WasmwardConfigInput = config()) => {
    const guard = createVersionGuard(input, { server: primary, fallbackServers: [fallback] });
    guards.push(guard);
    return guard;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    primary = new FakeChain();
    fallback = new FakeChain();
    primary.setWasm(VAULT, V1);
    fallback.setWasm(VAULT, V1);
  });

  afterEach(async () => {
    for (const guard of guards.splice(0)) await guard.stop();
    vi.useRealTimers();
  });

  it('is supported through the primary and reports that no fallback is in use', async () => {
    const guard = make();
    await guard.start();
    expect(guard.isWritable('vault')).toBe(true);
    expect(guard.health().network).toEqual({ passphrase: PASSPHRASE, verified: true, usingFallback: false });
    expect(fallback.lookupCalls).toEqual([]);
  });

  it('starts on a fallback when the primary cannot be reached, and says so in the health report', async () => {
    primary.failNetwork = new Error('connection refused');
    const guard = make();
    await guard.start();
    expect(guard.isWritable('vault')).toBe(true);
    expect(guard.health().network.usingFallback).toBe(true);
    expect(primary.lookupCalls).toEqual([]);
  });

  it('refuses to start when the primary serves another network, whatever the fallback says', async () => {
    primary.passphrase = 'Public Global Stellar Network ; September 2015';
    const guard = make();
    await expect(guard.start()).rejects.toBeInstanceOf(ConfigError);
    expect(fallback.networkCalls).toBe(0);
    expect(guard.isWritable('vault')).toBe(false);
  });

  it('stays writable through a primary outage by polling the fallback', async () => {
    const guard = make();
    await guard.start();
    primary.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(ONE_POLL * 8);
    expect(guard.isWritable('vault')).toBe(true);
    expect(guard.status().vault?.status).toBe('supported');
    expect(guard.status().vault?.consecutiveErrors).toBe(0);
    expect(guard.health().network.usingFallback).toBe(true);
  });

  it('would have gone stale without the fallback', async () => {
    const lonely = createVersionGuard(
      { ...config(), network: { rpcUrl: 'https://primary.example.org', passphrase: PASSPHRASE } },
      { server: primary },
    );
    guards.push(lonely);
    await lonely.start();
    primary.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lonely.isWritable('vault')).toBe(false);
    expect(lonely.status().vault?.status).toBe('stale');
  });

  it('sees an upgrade through the fallback', async () => {
    const guard = make();
    const changes: StatusChange[] = [];
    guard.subscribe((change) => {
      changes.push(change);
    });
    await guard.start();
    primary.failLookups = new Error('rpc down');
    fallback.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(guard.status().vault).toMatchObject({ status: 'unsupported', liveWasmHash: V2 });
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['pending>supported', 'supported>unsupported']);
    expect(() => guard.assertWritable('vault')).toThrow(WriteBlockedError);
  });

  it('never trusts a fallback on another network: the contract goes stale instead', async () => {
    fallback.passphrase = 'Public Global Stellar Network ; September 2015';
    const guard = make();
    await guard.start();
    primary.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fallback.lookupCalls).toEqual([]);
    expect(guard.isWritable('vault')).toBe(false);
    expect(guard.status().vault?.lastError).toContain('endpoint 1: The RPC serves network');
  });

  it('uses the fallback for a fresh check too', async () => {
    const guard = make();
    await guard.start();
    primary.failLookups = new Error('rpc down');
    fallback.setWasm(VAULT, V2);
    await expect(guard.assertWritableFresh('vault')).rejects.toBeInstanceOf(WriteBlockedError);
    expect(guard.status().vault?.liveWasmHash).toBe(V2);
  });

  it('goes back to the primary once it has recovered', async () => {
    const guard = make();
    await guard.start();
    primary.failLookups = new Error('rpc down');
    await vi.advanceTimersByTimeAsync(ONE_POLL * 2);
    expect(guard.health().network.usingFallback).toBe(true);
    primary.failLookups = undefined;
    await vi.advanceTimersByTimeAsync(ONE_POLL * 12);
    expect(guard.health().network.usingFallback).toBe(false);
  });

  it('blocks everything when every endpoint is down, and says which ones failed', async () => {
    const guard = make();
    await guard.start();
    primary.failLookups = new Error('one');
    fallback.failLookups = new Error('two');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.isWritable('vault')).toBe(false);
    expect(guard.status().vault?.lastError).toBe('all 2 RPC endpoints failed (endpoint 0: one; endpoint 1: two)');
  });

  it('builds clients for the configured fallback URLs when none are injected', async () => {
    const guard = createVersionGuard(
      { ...config(), network: { rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: ['http://127.0.0.1:2'], passphrase: PASSPHRASE } },
    );
    guards.push(guard);
    vi.useRealTimers();
    await expect(guard.start()).rejects.toThrow(/all 2 RPC endpoints failed/);
  });
});

describe('CLI check with fallback endpoints', () => {
  let dir: string;
  let primary: FakeChain;
  let fallback: FakeChain;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wasmward-fallback-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    primary = new FakeChain();
    fallback = new FakeChain();
    primary.setWasm(VAULT, V1);
    fallback.setWasm(VAULT, V1);
  });

  let counter = 0;
  async function configFile(): Promise<string> {
    counter += 1;
    const path = join(dir, `wasmward-${counter}.json`);
    await writeFile(
      path,
      JSON.stringify(
        configInput({ rpcUrl: 'http://127.0.0.1:9', fallbackRpcUrls: ['http://127.0.0.1:10'] }),
        null,
        2,
      ),
    );
    return path;
  }

  async function check(args: string[] = []) {
    let out = '';
    let err = '';
    const code = await main(['check', '--config', await configFile(), ...args], {
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      createServer: () => primary,
      createFallbackServers: () => [fallback],
      now: () => 1_000_000,
    });
    return { code, out, err };
  }

  it('does not use the fallback while the primary answers', async () => {
    const result = await check();
    expect(result.code).toBe(EXIT_OK);
    expect(fallback.lookupCalls).toEqual([]);
  });

  it('exits 0 through the fallback when the primary is down, and reports it in JSON', async () => {
    primary.failNetwork = new Error('connection refused');
    primary.failLookups = new Error('connection refused');
    const result = await check(['--json']);
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.out)).toMatchObject({ ok: true, exitCode: 0, network: { usingFallback: true, verified: true } });
  });

  it('exits 1 when the fallback shows unsupported code', async () => {
    primary.failNetwork = new Error('down');
    fallback.setWasm(VAULT, V2);
    expect((await check()).code).toBe(EXIT_NOT_SUPPORTED);
  });

  it('exits 2 when the primary serves another network', async () => {
    primary.passphrase = 'Public Global Stellar Network ; September 2015';
    const result = await check();
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('Public Global Stellar Network');
    expect(fallback.networkCalls).toBe(0);
  });

  it('exits 2 when every endpoint is unreachable', async () => {
    primary.failNetwork = new Error('a');
    fallback.failNetwork = new Error('b');
    const result = await check();
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('all 2 RPC endpoints failed');
  });

  it('exits 2, not 0, when the fallback is on another network and the primary is down', async () => {
    primary.failNetwork = new Error('down');
    fallback.passphrase = 'Public Global Stellar Network ; September 2015';
    const result = await check();
    expect(result.code).toBe(EXIT_ERROR);
    expect(fallback.lookupCalls).toEqual([]);
  });
});
