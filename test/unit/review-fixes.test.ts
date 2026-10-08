import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, main } from '../../src/cli-core.js';
import { usesPlainHttp } from '../../src/config.js';
import { createEndpointSet } from '../../src/endpoints.js';
import { ConfigError } from '../../src/errors.js';
import { createVersionGuard, type StatusChange, type VersionGuard } from '../../src/guard.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

/**
 * Regression tests for bugs found by reading the code back after it was written. Each of these failed
 * before its fix.
 */
const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const MAINNET = 'Public Global Stellar Network ; September 2015';

const guards: VersionGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the stale timer does not spin once a contract has been announced stale', () => {
  let chain: FakeChain;

  beforeEach(() => {
    vi.useFakeTimers();
    // The longest jitter: the next failing poll is as late as possible, leaving a long quiet window.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    chain = new FakeChain();
    chain.setWasm(VAULT, V1);
  });

  it('arms no further timer after the announcement, until a poll changes something', async () => {
    const guard = createVersionGuard(
      {
        version: 1,
        network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
        pollIntervalMs: 5_000,
        maxStalenessMs: 30_000,
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
      },
      { server: chain },
    );
    guards.push(guard);
    const changes: StatusChange[] = [];
    guard.subscribe((change) => {
      changes.push(change);
    });
    await guard.start();
    chain.failLookups = new Error('rpc down');

    await vi.advanceTimersByTimeAsync(30_001); // the contract goes stale, and is announced
    expect(changes.map((c) => c.to)).toEqual(['supported', 'stale']);

    // The next failing poll is about 3 s away. In between, nothing may keep re-arming a timer.
    const armed = vi.spyOn(globalThis, 'setTimeout');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(armed).not.toHaveBeenCalled();
    expect(changes.map((c) => c.to)).toEqual(['supported', 'stale']);
  });
});

describe('a primary on the wrong network stays a configuration error when asked again', () => {
  it('rejects again with ConfigError instead of quietly moving on to a fallback', async () => {
    const primary = new FakeChain();
    primary.passphrase = MAINNET;
    const fallback = new FakeChain();
    const endpoints = createEndpointSet([primary, fallback], PASSPHRASE, 5_000);

    await expect(endpoints.verifyNetwork()).rejects.toBeInstanceOf(ConfigError);
    await expect(endpoints.verifyNetwork()).rejects.toBeInstanceOf(ConfigError);
    expect(fallback.networkCalls).toBe(0);
    expect(endpoints.usingFallback).toBe(false);
  });

  it('keeps start() failing on retry, so the guard never runs on the fallback', async () => {
    const primary = new FakeChain();
    primary.passphrase = MAINNET;
    const fallback = new FakeChain();
    fallback.setWasm(VAULT, V1);
    const guard = createVersionGuard(
      {
        version: 1,
        network: { rpcUrl: 'https://primary.example.org', fallbackRpcUrls: ['https://fallback.example.org'], passphrase: PASSPHRASE },
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
      },
      { server: primary, fallbackServers: [fallback] },
    );
    guards.push(guard);

    await expect(guard.start()).rejects.toBeInstanceOf(ConfigError);
    await expect(guard.start()).rejects.toBeInstanceOf(ConfigError);
    expect(fallback.networkCalls).toBe(0);
    expect(fallback.lookupCalls).toEqual([]);
    expect(guard.isWritable('vault')).toBe(false);
  });
});

describe('an http URL is recognised however its scheme is spelled', () => {
  it.each([
    ['http://127.0.0.1:8000', true],
    ['HTTP://127.0.0.1:8000', true],
    ['Http://LocalHost:8000/rpc', true],
    ['https://rpc.example.org', false],
    ['HTTPS://rpc.example.org', false],
    ['not a url', false],
    ['', false],
  ])('usesPlainHttp(%j) is %s', (url, expected) => {
    expect(usesPlainHttp(url)).toBe(expected);
  });

  it('lets a guard with an uppercase http scheme be built and fail like any unreachable RPC', async () => {
    const guard = createVersionGuard({
      version: 1,
      network: { rpcUrl: 'HTTP://127.0.0.1:1', passphrase: PASSPHRASE },
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
    });
    guards.push(guard);
    await expect(guard.start()).rejects.toThrow(/Could not verify the network/);
  });

  describe('through the CLI', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'wasmward-review-'));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('check reports an unreachable RPC, not an "insecure server" crash', async () => {
      const config = join(dir, 'upper.json');
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          network: { rpcUrl: 'HTTP://127.0.0.1:1', passphrase: PASSPHRASE },
          contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
        }),
      );
      let err = '';
      const code = await main(['check', '--config', config], { stdout: () => undefined, stderr: (text) => (err += text) });
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain('Could not verify the network');
      expect(err).not.toMatch(/insecure/i);
    });
  });
});
