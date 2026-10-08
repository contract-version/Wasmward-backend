import type { rpc, xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchExecutables, MAX_KEYS_PER_REQUEST, type LedgerEntriesSource } from '../../src/fetch.js';
import { contractIdOf, hashOf, instanceKeyFor, nonContractEntry, parsedCodeEntry, parsedEntry } from '../fixtures/ledger.js';

const LATEST = 1_000;

type Handler = (keys: xdr.LedgerKey[]) => Promise<rpc.Api.GetLedgerEntriesResponse> | rpc.Api.GetLedgerEntriesResponse;

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A stand-in RPC. `calls` holds the instance lookups; the follow-up lookups for Wasm code entries are
 * answered with a live entry (so most tests ignore them) unless `codeHandler` says otherwise, and are
 * counted in `codeCalls`.
 */
function stub(
  handler: Handler,
  codeHandler?: Handler,
): LedgerEntriesSource & { calls: xdr.LedgerKey[][]; codeCalls: xdr.LedgerKey[][] } {
  const calls: xdr.LedgerKey[][] = [];
  const codeCalls: xdr.LedgerKey[][] = [];
  return {
    calls,
    codeCalls,
    getLedgerEntries: (...keys) => {
      if (keys.length > 0 && keys.every((key) => key.type === 'contractCode')) {
        codeCalls.push(keys);
        if (codeHandler !== undefined) return Promise.resolve(codeHandler(keys));
        return Promise.resolve(
          respond(
            keys.map((key) => (key.type === 'contractCode' ? parsedCodeEntry(toHex(key.contractCode.hash.toBytes()), LATEST + 10_000) : never())),
          ),
        );
      }
      calls.push(keys);
      return Promise.resolve(handler(keys));
    },
  };
}

function never(): never {
  throw new Error('unreachable');
}

function respond(
  entries: rpc.Api.LedgerEntryResult[],
  latestLedger = LATEST,
): rpc.Api.GetLedgerEntriesResponse {
  return { entries, latestLedger };
}

const A = contractIdOf(1);
const B = contractIdOf(2);
const C = contractIdOf(3);

describe('fetchExecutables: each result kind', () => {
  it('reports the Wasm hash of a live instance as lowercase hex', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 50)]));
    const result = await fetchExecutables(source, [A], 1_000);
    expect(result.get(A)).toEqual({
      kind: 'wasm',
      wasmHash: hashOf(1),
      liveUntilLedger: LATEST + 50,
      codeLiveUntilLedger: LATEST + 10_000,
      latestLedger: LATEST,
    });
  });

  it('treats liveUntilLedgerSeq equal to latestLedger as still live', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('wasm');
  });

  it('reports a Stellar Asset Contract', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'asset' }, LATEST + 5)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({ kind: 'stellar-asset', latestLedger: LATEST });
  });

  it('reports a Stellar Asset Contract without a TTL as stellar-asset', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'asset' }, undefined)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('stellar-asset');
  });

  it('reports a contract with no entry as missing', async () => {
    const source = stub(() => respond([]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({ kind: 'missing', latestLedger: LATEST });
  });

  it('treats a response without an entries field as no entries found', async () => {
    const source = stub(() => ({ latestLedger: LATEST }) as unknown as rpc.Api.GetLedgerEntriesResponse);
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('missing');
  });

  it('reports an expired instance as archived', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST - 1)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({
      kind: 'archived',
      liveUntilLedger: LATEST - 1,
      latestLedger: LATEST,
    });
  });

  it('treats a zero liveUntilLedgerSeq as archived', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, 0)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('archived');
  });

  it('reports an expired Stellar Asset Contract as archived', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'asset' }, LATEST - 1)]));
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('archived');
  });

  it('refuses to guess when liveUntilLedgerSeq is missing for a Wasm instance', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, undefined)]));
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('liveUntilLedgerSeq') });
  });

  it('returns an error for an external-reference executable', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'external' }, LATEST + 5)]));
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('external-reference') });
  });

  it('returns an error when the entry value is not a contract instance', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'not-instance' }, LATEST + 5)]));
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('not a contract instance') });
  });

  it('returns an error when the entry is not contract data', async () => {
    const source = stub(() => respond([nonContractEntry(A)]));
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('not contract data') });
  });

  it('returns an error when the entry cannot be decoded', async () => {
    const broken = { ...parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 5), val: null } as never;
    const source = stub(() => respond([broken]));
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('could not decode') });
  });
});

describe('fetchExecutables: batching and matching', () => {
  it('uses one call for several contracts and handles mixed outcomes', async () => {
    const source = stub(() =>
      respond([
        parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 10),
        parsedEntry(C, { type: 'asset' }, LATEST + 10),
      ]),
    );
    const result = await fetchExecutables(source, [A, B, C], 1_000);
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]).toHaveLength(3);
    expect(result.get(A)?.kind).toBe('wasm');
    expect(result.get(B)?.kind).toBe('missing');
    expect(result.get(C)?.kind).toBe('stellar-asset');
    expect([...result.keys()]).toEqual(expect.arrayContaining([A, B, C]));
  });

  it('matches entries to contracts by key, not by position', async () => {
    const source = stub(() =>
      respond([
        parsedEntry(C, { type: 'wasm', hash: hashOf(3) }, LATEST + 10),
        parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 10),
      ]),
    );
    const result = await fetchExecutables(source, [A, B, C], 1_000);
    expect(result.get(A)).toMatchObject({ kind: 'wasm', wasmHash: hashOf(1) });
    expect(result.get(C)).toMatchObject({ kind: 'wasm', wasmHash: hashOf(3) });
    expect(result.get(B)?.kind).toBe('missing');
  });

  it('ignores entries for keys that were not requested', async () => {
    const source = stub(() => respond([parsedEntry(contractIdOf(77), { type: 'wasm', hash: hashOf(9) }, LATEST + 1)]));
    const result = await fetchExecutables(source, [A], 1_000);
    expect(result.get(A)?.kind).toBe('missing');
    expect(result.size).toBe(1);
  });

  it('keeps the first entry when the RPC returns the same key twice', async () => {
    const source = stub(() =>
      respond([
        parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 10),
        parsedEntry(A, { type: 'wasm', hash: hashOf(2) }, LATEST + 10),
      ]),
    );
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toMatchObject({ wasmHash: hashOf(1) });
  });

  it('requests a duplicated contract ID once', async () => {
    const source = stub(() => respond([]));
    await fetchExecutables(source, [A, A, B], 1_000);
    expect(source.calls[0]).toHaveLength(2);
  });

  it('makes no call and returns an empty map for no contracts', async () => {
    const source = stub(() => respond([]));
    const result = await fetchExecutables(source, [], 1_000);
    expect(result.size).toBe(0);
    expect(source.calls).toHaveLength(0);
  });

  it('splits requests into chunks of at most 200 keys', async () => {
    const ids = Array.from({ length: MAX_KEYS_PER_REQUEST * 2 + 5 }, (_, i) => contractIdOf(i + 10));
    const source = stub(() => respond([]));
    const result = await fetchExecutables(source, ids, 1_000);
    expect(source.calls.map((keys) => keys.length).sort((a, b) => b - a)).toEqual([200, 200, 5]);
    expect(result.size).toBe(ids.length);
    expect([...result.values()].every((r) => r.kind === 'missing')).toBe(true);
  });

  it('sends exactly 200 keys in a single call', async () => {
    const ids = Array.from({ length: MAX_KEYS_PER_REQUEST }, (_, i) => contractIdOf(i + 10));
    const source = stub(() => respond([]));
    await fetchExecutables(source, ids, 1_000);
    expect(source.calls).toHaveLength(1);
  });

  it('fails only the chunk whose call failed', async () => {
    const ids = Array.from({ length: MAX_KEYS_PER_REQUEST + 1 }, (_, i) => contractIdOf(i + 10));
    let call = 0;
    const source = stub(() => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return respond([]);
    });
    const result = await fetchExecutables(source, ids, 1_000);
    const kinds = new Set([...result.values()].map((r) => r.kind));
    expect(kinds).toEqual(new Set(['error', 'missing']));
    expect(result.size).toBe(ids.length);
  });

  it('returns an error for an invalid contract ID and still looks up the rest', async () => {
    const source = stub(() => respond([parsedEntry(A, { type: 'wasm', hash: hashOf(1) }, LATEST + 10)]));
    const result = await fetchExecutables(source, ['not-a-contract', A], 1_000);
    expect(result.get('not-a-contract')).toMatchObject({ kind: 'error', message: expect.stringContaining('invalid contract ID') });
    expect(result.get(A)?.kind).toBe('wasm');
    expect(source.calls[0]).toHaveLength(1);
  });
});

describe('fetchExecutables: failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an error for every contract when the call rejects', async () => {
    const source = stub(() => {
      throw new Error('connection refused');
    });
    const result = await fetchExecutables(source, [A, B], 1_000);
    expect(result.get(A)).toEqual({ kind: 'error', message: 'connection refused' });
    expect(result.get(B)).toEqual({ kind: 'error', message: 'connection refused' });
  });

  it('wraps a non-Error rejection', async () => {
    const source: LedgerEntriesSource = { getLedgerEntries: () => Promise.reject('plain string') };
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({ kind: 'error', message: 'plain string' });
  });

  it('times out a call that never settles', async () => {
    const source: LedgerEntriesSource = { getLedgerEntries: () => new Promise(() => undefined) };
    const pending = fetchExecutables(source, [A, B], 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.get(A)).toEqual({ kind: 'error', message: 'getLedgerEntries timed out after 5000ms' });
    expect(result.get(B)).toEqual({ kind: 'error', message: 'getLedgerEntries timed out after 5000ms' });
  });

  it('does not leave a timer behind after a fast response', async () => {
    const source = stub(() => respond([]));
    await fetchExecutables(source, [A], 5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns errors when latestLedger is missing from the response', async () => {
    const source = stub(() => ({ entries: [] }) as unknown as rpc.Api.GetLedgerEntriesResponse);
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('latestLedger') });
  });
});

describe('fetchExecutables: the Wasm code entry has its own lifetime', () => {
  const instance = (id: string, hash: string, liveUntil = LATEST + 50_000): rpc.Api.LedgerEntryResult =>
    parsedEntry(id, { type: 'wasm', hash }, liveUntil);

  it('reports when the instance and the code expire separately', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1), LATEST + 900)]),
      () => respond([parsedCodeEntry(hashOf(1), LATEST + 300)]),
    );
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({
      kind: 'wasm',
      wasmHash: hashOf(1),
      liveUntilLedger: LATEST + 900,
      codeLiveUntilLedger: LATEST + 300,
      latestLedger: LATEST,
    });
  });

  it('calls a contract archived when its code entry has expired, even though the instance is live', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => respond([parsedCodeEntry(hashOf(1), LATEST - 1)]),
    );
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({
      kind: 'archived',
      entry: 'code',
      wasmHash: hashOf(1),
      liveUntilLedger: LATEST - 1,
      latestLedger: LATEST,
    });
  });

  it('treats a code entry live until exactly the latest ledger as still live', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => respond([parsedCodeEntry(hashOf(1), LATEST)]),
    );
    expect((await fetchExecutables(source, [A], 1_000)).get(A)?.kind).toBe('wasm');
  });

  it('calls a contract archived when the RPC has no code entry for it at all', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => respond([]),
    );
    // No lifetime is known, so none is claimed.
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toEqual({
      kind: 'archived',
      entry: 'code',
      wasmHash: hashOf(1),
      latestLedger: LATEST,
    });
  });

  it('cannot rule out expiry when the RPC leaves out the code entry lifetime', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => respond([parsedCodeEntry(hashOf(1), undefined)]),
    );
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toMatchObject({ kind: 'error' });
    expect(result?.kind === 'error' && result.message).toMatch(/liveUntilLedgerSeq for the Wasm code entry/);
  });

  it('reports an error, not an archive, when the code lookup itself fails', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => {
        throw new Error('connection reset');
      },
    );
    const result = (await fetchExecutables(source, [A], 1_000)).get(A);
    expect(result).toEqual({ kind: 'error', message: 'could not read the Wasm code entry: connection reset' });
  });

  it('reports an error when the code lookup answers without a usable latestLedger', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1))]),
      () => ({ entries: [], latestLedger: Number.NaN }),
    );
    expect((await fetchExecutables(source, [A], 1_000)).get(A)).toMatchObject({ kind: 'error' });
  });

  it('gives up on a hung code lookup at the timeout', async () => {
    vi.useFakeTimers();
    try {
      const source = stub(
        () => respond([instance(A, hashOf(1))]),
        () => new Promise<never>(() => undefined),
      );
      const pending = fetchExecutables(source, [A], 1_000);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toEqual(new Map([[A, { kind: 'error', message: 'could not read the Wasm code entry: getLedgerEntries (code) timed out after 1000ms' }]]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads each distinct Wasm hash once, however many contracts run it', async () => {
    const source = stub(() => respond([instance(A, hashOf(1)), instance(B, hashOf(1)), instance(C, hashOf(2))]));
    const result = await fetchExecutables(source, [A, B, C], 1_000);
    expect(source.codeCalls).toHaveLength(1);
    expect(source.codeCalls[0]).toHaveLength(2);
    expect([A, B, C].map((id) => result.get(id)?.kind)).toEqual(['wasm', 'wasm', 'wasm']);
  });

  it('applies one expired code entry to every contract that runs that build, and only those', async () => {
    const source = stub(
      () => respond([instance(A, hashOf(1)), instance(B, hashOf(1)), instance(C, hashOf(2))]),
      () => respond([parsedCodeEntry(hashOf(2), LATEST + 10), parsedCodeEntry(hashOf(1), LATEST - 5)]),
    );
    const result = await fetchExecutables(source, [A, B, C], 1_000);
    // The answer lists hash 2 first: entries are matched by key, never by position.
    expect([A, B, C].map((id) => result.get(id)?.kind)).toEqual(['archived', 'archived', 'wasm']);
    expect(result.get(C)).toMatchObject({ codeLiveUntilLedger: LATEST + 10 });
  });

  it('does not look up code for contracts that are not running Wasm', async () => {
    const source = stub(() =>
      respond([parsedEntry(A, { type: 'asset' }, LATEST + 50), parsedEntry(B, { type: 'wasm', hash: hashOf(1) }, LATEST - 1)]),
    );
    const result = await fetchExecutables(source, [A, B, C], 1_000);
    expect(source.codeCalls).toHaveLength(0);
    expect([A, B, C].map((id) => result.get(id)?.kind)).toEqual(['stellar-asset', 'archived', 'missing']);
  });

  it('splits the code lookup at the per-request limit', async () => {
    const total = MAX_KEYS_PER_REQUEST + 5;
    const ids = Array.from({ length: total }, (_, i) => contractIdOf(1_000 + i));
    // Every contract runs its own build, so there are more distinct hashes than one request may carry.
    const byKey = new Map(ids.map((id, i) => [instanceKeyFor(id).toXdr('base64'), instance(id, hashOf(i))]));
    const source = stub((keys) => respond(keys.flatMap((key) => byKey.get(key.toXdr('base64')) ?? [])));
    const result = await fetchExecutables(source, ids, 1_000);
    expect(result.size).toBe(total);
    expect([...result.values()].every((r) => r.kind === 'wasm')).toBe(true);
    expect(source.codeCalls.map((keys) => keys.length).sort((a, b) => a - b)).toEqual([5, MAX_KEYS_PER_REQUEST]);
  });
});
