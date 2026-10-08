import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEndpointSet, PRIMARY_RETRY_EVERY } from '../../src/endpoints.js';
import { ConfigError } from '../../src/errors.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const A = contractIdOf(1);
const B = contractIdOf(2);
const V1 = hashOf(1);
const TIMEOUT = 5_000;

let primary: FakeChain;
let fallback: FakeChain;
let second: FakeChain;

beforeEach(() => {
  primary = new FakeChain();
  fallback = new FakeChain();
  second = new FakeChain();
  for (const chain of [primary, fallback, second]) {
    chain.setWasm(A, V1);
    chain.setWasm(B, V1);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

const set = (...servers: FakeChain[]) => createEndpointSet(servers, PASSPHRASE, TIMEOUT);

describe('with a single endpoint', () => {
  it('verifies the network once and looks up through it', async () => {
    const endpoints = set(primary);
    await endpoints.verifyNetwork();
    const results = await endpoints.lookup([A, B], TIMEOUT);
    expect(results.get(A)).toMatchObject({ kind: 'wasm', wasmHash: V1 });
    expect(results.get(B)).toMatchObject({ kind: 'wasm', wasmHash: V1 });
    expect(primary.networkCalls).toBe(1);
    expect(primary.lookupCalls).toEqual([2]);
    expect(endpoints.usingFallback).toBe(false);
  });

  it('reports a lookup failure as the plain error message', async () => {
    const endpoints = set(primary);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    const results = await endpoints.lookup([A], TIMEOUT);
    expect(results.get(A)).toEqual({ kind: 'error', message: 'rpc down' });
  });

  it('reports an unreachable network as "Could not verify the network: <message>"', async () => {
    primary.failNetwork = new Error('connection refused');
    await expect(set(primary).verifyNetwork()).rejects.toThrow('Could not verify the network: connection refused');
  });

  it('throws ConfigError for a network mismatch', async () => {
    primary.passphrase = 'Public Global Stellar Network ; September 2015';
    await expect(set(primary).verifyNetwork()).rejects.toBeInstanceOf(ConfigError);
  });

  it('refuses to be built with no servers', () => {
    expect(() => createEndpointSet([], PASSPHRASE, TIMEOUT)).toThrow('at least one server');
  });

  it('returns an empty map for no contracts without calling anything', async () => {
    const endpoints = set(primary);
    await endpoints.verifyNetwork();
    expect((await endpoints.lookup([], TIMEOUT)).size).toBe(0);
    expect(primary.lookupCalls).toEqual([]);
  });
});

describe('verifyNetwork with fallbacks', () => {
  it('uses only the primary when it answers', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    expect(fallback.networkCalls).toBe(0);
    expect(endpoints.usingFallback).toBe(false);
  });

  it('moves to a fallback when the primary cannot be reached', async () => {
    primary.failNetwork = new Error('connection refused');
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    expect(fallback.networkCalls).toBe(1);
    expect(endpoints.usingFallback).toBe(true);
  });

  it('tries each fallback in order', async () => {
    primary.failNetwork = new Error('down');
    fallback.failNetwork = new Error('also down');
    const endpoints = set(primary, fallback, second);
    await endpoints.verifyNetwork();
    expect(second.networkCalls).toBe(1);
    expect(endpoints.usingFallback).toBe(true);
  });

  it('treats a primary on the wrong network as a configuration error and asks nobody else', async () => {
    primary.passphrase = 'Public Global Stellar Network ; September 2015';
    const endpoints = set(primary, fallback);
    await expect(endpoints.verifyNetwork()).rejects.toBeInstanceOf(ConfigError);
    expect(fallback.networkCalls).toBe(0);
  });

  it('never accepts a fallback on the wrong network, even when the primary is down', async () => {
    primary.failNetwork = new Error('down');
    fallback.passphrase = 'Public Global Stellar Network ; September 2015';
    const endpoints = set(primary, fallback);
    const error = await endpoints.verifyNetwork().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Could not verify the network: all 2 RPC endpoints failed');
    expect((error as Error).message).toContain('endpoint 0: down');
    expect((error as Error).message).toContain('endpoint 1: The RPC serves network "Public Global Stellar Network ; September 2015"');
    expect(endpoints.usingFallback).toBe(false);
  });

  it('fails with every endpoint listed when none answers', async () => {
    primary.failNetwork = new Error('a');
    fallback.failNetwork = new Error('b');
    await expect(set(primary, fallback).verifyNetwork()).rejects.toThrow(
      'Could not verify the network: all 2 RPC endpoints failed (endpoint 0: a; endpoint 1: b)',
    );
  });

  it('does not repeat a successful verification', async () => {
    const endpoints = set(primary);
    await endpoints.verifyNetwork();
    await endpoints.verifyNetwork();
    expect(primary.networkCalls).toBe(1);
  });
});

describe('lookup failover', () => {
  it('does not touch a fallback while the primary answers', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    await endpoints.lookup([A], TIMEOUT);
    expect(fallback.lookupCalls).toEqual([]);
    expect(fallback.networkCalls).toBe(0);
  });

  it('fails over when the primary cannot answer for any contract', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    const results = await endpoints.lookup([A, B], TIMEOUT);
    expect(results.get(A)).toMatchObject({ kind: 'wasm' });
    expect(results.get(B)).toMatchObject({ kind: 'wasm' });
    expect(endpoints.usingFallback).toBe(true);
    expect(fallback.lookupCalls).toEqual([2]);
  });

  it('verifies a fallback before its first use, and only once', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    await endpoints.lookup([A], TIMEOUT);
    await endpoints.lookup([A], TIMEOUT);
    expect(fallback.networkCalls).toBe(1);
  });

  it('never looks anything up on a fallback that serves another network', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    fallback.passphrase = 'Public Global Stellar Network ; September 2015';
    const results = await endpoints.lookup([A], TIMEOUT);
    expect(fallback.lookupCalls).toEqual([]);
    const result = results.get(A);
    expect(result?.kind).toBe('error');
    expect(result?.kind === 'error' ? result.message : '').toContain('all 2 RPC endpoints failed');
    expect(result?.kind === 'error' ? result.message : '').toContain('endpoint 0: rpc down');
    expect(result?.kind === 'error' ? result.message : '').toContain('endpoint 1: The RPC serves network');
    expect(endpoints.usingFallback).toBe(false);
  });

  it('does not ask a rejected fallback again', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    fallback.passphrase = 'Public Global Stellar Network ; September 2015';
    await endpoints.lookup([A], TIMEOUT);
    await endpoints.lookup([A], TIMEOUT);
    expect(fallback.networkCalls).toBe(1);
  });

  it('does not fail over for an error that affects only some contracts', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    // Look up one real contract and one invalid ID: the primary answers, so nobody else is asked.
    const results = await endpoints.lookup([A, 'not-a-contract'], TIMEOUT);
    expect(results.get(A)?.kind).toBe('wasm');
    expect(results.get('not-a-contract')?.kind).toBe('error');
    expect(fallback.lookupCalls).toEqual([]);
  });

  it('treats a contract that does not exist as an answer, not a failure', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.remove(A);
    const results = await endpoints.lookup([A], TIMEOUT);
    expect(results.get(A)?.kind).toBe('missing');
    expect(fallback.lookupCalls).toEqual([]);
  });

  it('returns an error for every contract, naming each endpoint, when all fail', async () => {
    const endpoints = set(primary, fallback, second);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('one');
    fallback.failLookups = new Error('two');
    second.failLookups = new Error('three');
    const results = await endpoints.lookup([A, B], TIMEOUT);
    for (const id of [A, B]) {
      expect(results.get(id)).toEqual({
        kind: 'error',
        message: 'all 3 RPC endpoints failed (endpoint 0: one; endpoint 1: two; endpoint 2: three)',
      });
    }
  });

  it('never puts an endpoint URL in its messages: endpoints are identified by position', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('x');
    fallback.failLookups = new Error('y');
    const message = JSON.stringify([...(await endpoints.lookup([A], TIMEOUT)).values()]);
    expect(message).not.toMatch(/https?:\/\//);
  });
});

describe('preference and returning to the primary', () => {
  it('keeps using the working fallback instead of timing out on the primary every time', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    await endpoints.lookup([A], TIMEOUT); // fails over
    const primaryCallsAfterFailover = primary.lookupCalls.length;
    await endpoints.lookup([A], TIMEOUT);
    await endpoints.lookup([A], TIMEOUT);
    expect(primary.lookupCalls.length).toBe(primaryCallsAfterFailover);
    expect(fallback.lookupCalls.length).toBe(3);
  });

  it('tries the primary first again every few lookups, and goes back when it has recovered', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    await endpoints.lookup([A], TIMEOUT); // lookup 1: failed over
    expect(endpoints.usingFallback).toBe(true);

    primary.failLookups = undefined; // the primary recovers
    for (let lookup = 2; lookup < PRIMARY_RETRY_EVERY; lookup += 1) {
      await endpoints.lookup([A], TIMEOUT);
      expect(endpoints.usingFallback).toBe(true);
    }
    await endpoints.lookup([A], TIMEOUT); // lookup PRIMARY_RETRY_EVERY: primary is tried first
    expect(endpoints.usingFallback).toBe(false);
    expect(primary.lookupCalls.length).toBeGreaterThan(1);
  });

  it('falls back again if the primary is still down when retried', async () => {
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    for (let lookup = 1; lookup <= PRIMARY_RETRY_EVERY; lookup += 1) {
      const results = await endpoints.lookup([A], TIMEOUT);
      expect(results.get(A)?.kind).toBe('wasm');
    }
    expect(endpoints.usingFallback).toBe(true);
  });
});

describe('timeouts', () => {
  it('fails over when the primary hangs past the lookup timeout', async () => {
    vi.useFakeTimers();
    const endpoints = set(primary, fallback);
    await endpoints.verifyNetwork();
    primary.gate = new Promise<void>(() => undefined); // never answers
    const pending = endpoints.lookup([A], TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    const results = await pending;
    expect(results.get(A)?.kind).toBe('wasm');
    expect(endpoints.usingFallback).toBe(true);
  });

  it('fails over when a fallback network check hangs, without waiting forever', async () => {
    vi.useFakeTimers();
    const hanging = {
      getNetwork: () => new Promise<never>(() => undefined),
      getLedgerEntries: fallback.getLedgerEntries,
    };
    const endpoints = createEndpointSet([primary, hanging, second], PASSPHRASE, TIMEOUT);
    await endpoints.verifyNetwork();
    primary.failLookups = new Error('rpc down');
    const pending = endpoints.lookup([A], TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT * 2);
    const results = await pending;
    expect(results.get(A)?.kind).toBe('wasm');
    expect(second.lookupCalls).toEqual([1]);
  });
});
