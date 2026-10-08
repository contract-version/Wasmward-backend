import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_NOT_SUPPORTED, EXIT_OK, main } from '../../src/cli-core.js';
import { createVersionGuard, type VersionGuard } from '../../src/guard.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

/**
 * A contract needs two ledger entries to run: its instance and the Wasm code. Each has its own lifetime.
 * A live instance with expired code still looks healthy to anyone who only reads the instance, but every
 * call fails. These tests are about that gap.
 */

const VAULT = contractIdOf(1);
const POOL = contractIdOf(2);
const V1 = hashOf(1);
const V2 = hashOf(2);
const POLL = 30_000;
const ONE_POLL = POLL * 1.1;

let chain: FakeChain;

beforeEach(() => {
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
});

describe('the guard and an expired Wasm code entry', () => {
  const guards: VersionGuard[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const guard of guards.splice(0)) await guard.stop();
    vi.useRealTimers();
  });

  async function started(): Promise<VersionGuard> {
    const guard = createVersionGuard(
      {
        version: 1,
        network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
        pollIntervalMs: POLL,
        maxStalenessMs: 120_000,
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] } },
      },
      { server: chain },
    );
    guards.push(guard);
    await guard.start();
    return guard;
  }

  it('blocks writes, saying it is the code and not the instance, even though the instance is live', async () => {
    chain.setCodeTtl(V1, -10);
    const guard = await started();
    const vault = guard.status()['vault'];
    expect(vault).toMatchObject({ status: 'archived', archivedEntry: 'code', liveWasmHash: V1 });
    expect(() => guard.assertWritable('vault')).toThrow(/Wasm code of the contract has expired/);
    expect(guard.health().ok).toBe(false);
    expect(guard.health().contracts['vault']).toMatchObject({ status: 'archived', writable: false });
  });

  it('notices code that expires after start, announces it once, and allows writes again after a restore', async () => {
    const guard = await started();
    const changes: string[] = [];
    guard.subscribe((change) => {
      changes.push(`${change.from}>${change.to}`);
    });
    expect(() => guard.assertWritable('vault')).not.toThrow();

    chain.setCodeTtl(V1, -1);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(() => guard.assertWritable('vault')).toThrow(/Wasm code/);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(changes.filter((change) => change.endsWith('>archived'))).toHaveLength(1);

    chain.setCodeTtl(V1, 5_000); // restored and extended
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(() => guard.assertWritable('vault')).not.toThrow();
    expect(guard.status()['vault']).not.toHaveProperty('archivedEntry');
  });

  it('blocks when the code entry has vanished from the ledger altogether', async () => {
    chain.removeCode(V1);
    const guard = await started();
    expect(guard.status()['vault']).toMatchObject({ status: 'archived', archivedEntry: 'code' });
    expect(guard.status()['vault']).not.toHaveProperty('codeLiveUntilLedger');
  });

  it('adds one follow-up lookup per poll round, however many contracts there are', async () => {
    chain.setWasm(POOL, V2);
    const guard = createVersionGuard(
      {
        version: 1,
        network: { rpcUrl: 'https://rpc.example.org', passphrase: PASSPHRASE },
        pollIntervalMs: POLL,
        maxStalenessMs: 120_000,
        contracts: {
          vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] },
          pool: { contractId: POOL, supported: [{ wasmHash: V2 }] },
        },
      },
      { server: chain },
    );
    guards.push(guard);
    await guard.start();
    expect(chain.lookupCalls).toEqual([2]);
    expect(chain.codeLookupCalls).toEqual([2]);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(chain.lookupCalls).toEqual([2, 2]);
    expect(chain.codeLookupCalls).toEqual([2, 2]);
  });

  it('reports the sooner of the two expiries, and which one it is', async () => {
    chain.ttl = 9_000;
    chain.setCodeTtl(V1, 4_000);
    const guard = await started();
    expect(guard.health().contracts['vault']).toMatchObject({ status: 'supported', ledgersUntilExpiry: 4_000, expiringEntry: 'code' });
    chain.setCodeTtl(V1, 20_000);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(guard.health().contracts['vault']).toMatchObject({ ledgersUntilExpiry: 9_000, expiringEntry: 'instance' });
  });
});

describe('wasmward check and an expiring Wasm code entry', () => {
  let dir: string;
  let config: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wasmward-code-expiry-'));
    config = join(dir, 'wasmward.json');
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        network: { rpcUrl: 'http://127.0.0.1:9', passphrase: PASSPHRASE },
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1' }] } },
      }),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function check(args: string[] = []): Promise<{ code: number; out: string }> {
    let out = '';
    const code = await main(['check', '--config', config, ...args], {
      stdout: (text) => (out += text),
      stderr: () => undefined,
      createServer: () => chain,
      createFallbackServers: () => [],
      now: () => 1_000_000,
    });
    return { code, out };
  }

  it('says "Wasm code" when the code runs out before the instance', async () => {
    chain.ttl = 400_000;
    chain.setCodeTtl(V1, 5_000);
    const { code, out } = await check();
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('(Wasm code expires in about 7 hours; extend its lifetime soon)');
  });

  it('keeps the usual wording when the instance is the one running out', async () => {
    chain.ttl = 5_000;
    chain.setCodeTtl(V1, 400_000);
    expect((await check()).out).toContain('(expires in about 7 hours; extend its lifetime soon)');
  });

  it('counts the code in --min-ttl-days: plenty of instance life is not enough', async () => {
    chain.ttl = 1_000_000;
    chain.setCodeTtl(V1, 100_000); // about 5.8 days
    const { code, out } = await check(['--min-ttl-days', '7']);
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(out).toContain('Wasm code expires in about 6 days: under the 7-day minimum');
    expect(out).toContain('0 of 1 contracts supported with at least 7 days left.');
  });

  it('passes --min-ttl-days when both entries have enough', async () => {
    chain.ttl = 1_000_000;
    chain.setCodeTtl(V1, 900_000);
    expect((await check(['--min-ttl-days', '7'])).code).toBe(EXIT_OK);
  });

  it('fails an expired code entry as archived, with a line that says what to restore', async () => {
    chain.setCodeTtl(V1, -1);
    const { code, out } = await check();
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(out).toContain('vault  archived: the Wasm code of the contract has expired (archived)');
  });

  it('reports which entry to extend in the JSON', async () => {
    chain.ttl = 400_000;
    chain.setCodeTtl(V1, 5_000);
    const report = JSON.parse((await check(['--json'])).out) as { contracts: Record<string, unknown> };
    expect(report.contracts['vault']).toMatchObject({ status: 'supported', ledgersUntilExpiry: 5_000, expiringEntry: 'code' });
  });
});
