import { describe, expect, it } from 'vitest';
import { effectiveStatus, initialState, isWritable, nextState } from '../../src/state.js';
import type { ContractConfig, ContractState, LiveExecutable, Status } from '../../src/types.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const MAX = 120_000;
const NOW = 1_000_000;
const V1 = hashOf(1);
const V2 = hashOf(2);
const UNKNOWN = hashOf(9);

const cfg: ContractConfig = {
  contractId: contractIdOf(1),
  supported: [{ wasmHash: V1, label: 'v1.0.0' }, { wasmHash: V2 }],
};

const ALL_STATUSES: Status[] = ['pending', 'supported', 'unsupported', 'stellar-asset', 'missing', 'archived', 'stale'];

/** A state that has been through a successful lookup, with leftovers from earlier results. */
function stateWith(status: Status, overrides: Partial<ContractState> = {}): ContractState {
  return {
    name: 'vault',
    contractId: cfg.contractId,
    status,
    liveWasmHash: V1,
    matchedLabel: 'v1.0.0',
    lastCheckedAt: NOW - 1_000,
    lastSuccessAt: NOW - 1_000,
    consecutiveErrors: 2,
    lastError: 'old failure',
    ...overrides,
  };
}

/** A copy of the state with no recorded successful lookup. */
function withoutLastSuccess(state: ContractState): ContractState {
  const copy = { ...state };
  delete copy.lastSuccessAt;
  return copy;
}

const wasm = (wasmHash: string): LiveExecutable => ({ kind: 'wasm', wasmHash, liveUntilLedger: 9_000, latestLedger: 100 });
const error: LiveExecutable = { kind: 'error', message: 'rpc down' };

describe('initialState', () => {
  it('starts pending with no history', () => {
    expect(initialState('vault', cfg)).toStrictEqual({
      name: 'vault',
      contractId: cfg.contractId,
      status: 'pending',
      consecutiveErrors: 0,
    });
  });
});

describe('nextState: successful lookups, from every previous status', () => {
  const cases: { name: string; result: LiveExecutable; status: Status; hash?: string; label?: string }[] = [
    { name: 'a supported hash with a label', result: wasm(V1), status: 'supported', hash: V1, label: 'v1.0.0' },
    { name: 'a supported hash without a label', result: wasm(V2), status: 'supported', hash: V2 },
    { name: 'an unknown hash', result: wasm(UNKNOWN), status: 'unsupported', hash: UNKNOWN },
    { name: 'a Stellar Asset Contract', result: { kind: 'stellar-asset', latestLedger: 100 }, status: 'stellar-asset' },
    { name: 'a missing instance', result: { kind: 'missing', latestLedger: 100 }, status: 'missing' },
    {
      name: 'an archived instance',
      result: { kind: 'archived', liveUntilLedger: 5, latestLedger: 100 },
      status: 'archived',
    },
  ];

  for (const previous of ALL_STATUSES) {
    describe(`from ${previous}`, () => {
      it.each(cases)('$name becomes the right status and resets bookkeeping', ({ result, status, hash, label }) => {
        const prev = previous === 'pending' ? withoutLastSuccess(stateWith('pending')) : stateWith(previous);
        const next = nextState(prev, result, cfg, NOW, MAX);

        const expected: ContractState = {
          name: 'vault',
          contractId: cfg.contractId,
          status,
          lastCheckedAt: NOW,
          lastSuccessAt: NOW,
          consecutiveErrors: 0,
        };
        if (hash !== undefined) expected.liveWasmHash = hash;
        if (label !== undefined) expected.matchedLabel = label;
        // toStrictEqual also proves cleared fields are absent, not set to undefined.
        expect(next).toStrictEqual(expected);
      });
    });
  }
});

describe('nextState: error results', () => {
  it('stays pending when no lookup has ever succeeded', () => {
    const prev = initialState('vault', cfg);
    expect(nextState(prev, error, cfg, NOW, MAX)).toStrictEqual({
      name: 'vault',
      contractId: cfg.contractId,
      status: 'pending',
      lastCheckedAt: NOW,
      lastError: 'rpc down',
      consecutiveErrors: 1,
    });
  });

  it('stays pending through repeated errors and counts them', () => {
    let state = initialState('vault', cfg);
    for (let i = 1; i <= 4; i += 1) {
      state = nextState(state, error, cfg, NOW + i * 60_000, MAX);
      expect(state.status).toBe('pending');
      expect(state.consecutiveErrors).toBe(i);
    }
  });

  describe.each(['supported', 'unsupported', 'stellar-asset', 'missing', 'archived'] as const)(
    'after a %s result',
    (previous) => {
      const prev = stateWith(previous, { consecutiveErrors: 0 });
      const lastSuccessAt = prev.lastSuccessAt as number;

      it('keeps the status, hash and label while the last success is within the limit', () => {
        const next = nextState(prev, error, cfg, lastSuccessAt + MAX - 1, MAX);
        expect(next).toStrictEqual({
          ...prev,
          lastCheckedAt: lastSuccessAt + MAX - 1,
          lastError: 'rpc down',
          consecutiveErrors: 1,
        });
      });

      it('still keeps the status when the last success is exactly at the limit', () => {
        expect(nextState(prev, error, cfg, lastSuccessAt + MAX, MAX).status).toBe(previous);
      });

      it('becomes stale one millisecond past the limit, keeping the hash for diagnosis', () => {
        const next = nextState(prev, error, cfg, lastSuccessAt + MAX + 1, MAX);
        expect(next.status).toBe('stale');
        expect(next.liveWasmHash).toBe(V1);
        expect(next.lastSuccessAt).toBe(lastSuccessAt);
        expect(next.consecutiveErrors).toBe(1);
      });
    },
  );

  it('stays stale on further errors', () => {
    const prev = stateWith('stale', { consecutiveErrors: 5 });
    const next = nextState(prev, error, cfg, NOW + MAX * 2, MAX);
    expect(next.status).toBe('stale');
    expect(next.consecutiveErrors).toBe(6);
  });

  it('records the newest error message', () => {
    const prev = stateWith('supported');
    const next = nextState(prev, { kind: 'error', message: 'timeout' }, cfg, NOW, MAX);
    expect(next.lastError).toBe('timeout');
  });

  it('recovers from stale to supported on the next good lookup', () => {
    const stale = nextState(stateWith('supported'), error, cfg, NOW + MAX * 2, MAX);
    expect(stale.status).toBe('stale');
    const recovered = nextState(stale, wasm(V1), cfg, NOW + MAX * 2 + 1, MAX);
    expect(recovered.status).toBe('supported');
    expect(recovered.consecutiveErrors).toBe(0);
    expect(recovered).not.toHaveProperty('lastError');
  });

  it('moves from supported to unsupported when the contract is upgraded', () => {
    const upgraded = nextState(stateWith('supported'), wasm(UNKNOWN), cfg, NOW, MAX);
    expect(upgraded.status).toBe('unsupported');
    expect(upgraded.liveWasmHash).toBe(UNKNOWN);
    expect(upgraded).not.toHaveProperty('matchedLabel');
  });

  it('moves back to supported once the new hash is in the config', () => {
    const wider: ContractConfig = { ...cfg, supported: [...cfg.supported, { wasmHash: UNKNOWN, label: 'v2.0.0' }] };
    const next = nextState(stateWith('unsupported', { liveWasmHash: UNKNOWN }), wasm(UNKNOWN), wider, NOW, MAX);
    expect(next).toMatchObject({ status: 'supported', matchedLabel: 'v2.0.0' });
  });
});

describe('nextState purity', () => {
  it('does not modify the previous state, result or config', () => {
    const prev = Object.freeze(stateWith('supported'));
    const result = Object.freeze(wasm(UNKNOWN));
    const frozenCfg = Object.freeze({ ...cfg, supported: Object.freeze(cfg.supported.map((v) => Object.freeze({ ...v }))) });
    const before = JSON.stringify(prev);
    expect(() => nextState(prev, result, frozenCfg as ContractConfig, NOW, MAX)).not.toThrow();
    expect(() => nextState(prev, error, frozenCfg as ContractConfig, NOW, MAX)).not.toThrow();
    expect(JSON.stringify(prev)).toBe(before);
  });

  it('returns a new object each time', () => {
    const prev = stateWith('supported');
    expect(nextState(prev, wasm(V1), cfg, NOW, MAX)).not.toBe(prev);
    expect(nextState(prev, error, cfg, NOW, MAX)).not.toBe(prev);
  });
});

describe('effectiveStatus and isWritable', () => {
  it('allows writes for supported with a fresh success', () => {
    const state = stateWith('supported', { lastSuccessAt: NOW - 10 });
    expect(effectiveStatus(state, NOW, MAX)).toBe('supported');
    expect(isWritable(state, NOW, MAX)).toBe(true);
  });

  it('allows writes exactly at the staleness limit', () => {
    const state = stateWith('supported', { lastSuccessAt: NOW - MAX });
    expect(isWritable(state, NOW, MAX)).toBe(true);
  });

  it('blocks writes one millisecond past the limit even though the stored status is supported', () => {
    const state = stateWith('supported', { lastSuccessAt: NOW - MAX - 1 });
    expect(state.status).toBe('supported');
    expect(effectiveStatus(state, NOW, MAX)).toBe('stale');
    expect(isWritable(state, NOW, MAX)).toBe(false);
  });

  it('turns stale with time alone, as when the poller has stopped', () => {
    const state = stateWith('supported', { lastSuccessAt: NOW });
    expect(isWritable(state, NOW + MAX, MAX)).toBe(true);
    expect(isWritable(state, NOW + MAX + 1, MAX)).toBe(false);
    expect(isWritable(state, NOW + 10 * MAX, MAX)).toBe(false);
  });

  it('fails closed when the clock has moved backwards', () => {
    const state = stateWith('supported', { lastSuccessAt: NOW + 5 });
    expect(effectiveStatus(state, NOW, MAX)).toBe('stale');
    expect(isWritable(state, NOW, MAX)).toBe(false);
  });

  it('fails closed when time is not a number', () => {
    const state = stateWith('supported');
    expect(isWritable(state, Number.NaN, MAX)).toBe(false);
  });

  it('fails closed when a supported state has no recorded success', () => {
    const state = withoutLastSuccess(stateWith('supported'));
    expect(effectiveStatus(state, NOW, MAX)).toBe('pending');
    expect(isWritable(state, NOW, MAX)).toBe(false);
  });

  it.each(ALL_STATUSES)('reports writable for %s only if it is supported', (status) => {
    const state = stateWith(status, { lastSuccessAt: NOW });
    expect(isWritable(state, NOW, MAX)).toBe(status === 'supported');
  });

  it.each(ALL_STATUSES.filter((status) => status !== 'supported'))('reports %s unchanged', (status) => {
    expect(effectiveStatus(stateWith(status), NOW + 10 * MAX, MAX)).toBe(status);
  });

  it('never allows writes for a state that has not completed a lookup', () => {
    expect(isWritable(initialState('vault', cfg), NOW, MAX)).toBe(false);
  });
});
