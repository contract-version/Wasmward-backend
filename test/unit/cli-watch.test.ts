import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const V2 = hashOf(2);
const POLL = 5_000;
/** One poll wait is at most 1.1 intervals. */
const ONE_POLL = POLL * 1.1;

let dir: string;
let config: string;
let chain: FakeChain;
let stop: AbortController;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-watch-'));
  config = join(dir, 'wasmward.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      network: { rpcUrl: 'http://127.0.0.1:9', passphrase: PASSPHRASE },
      pollIntervalMs: POLL,
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] } },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
  stop = new AbortController();
});

afterEach(() => {
  stop.abort();
  vi.useRealTimers();
});

/** Starts `wasmward watch` and returns handles to what it prints and its eventual exit code. */
function startWatch(args: string[] = [], signal: AbortSignal | undefined = stop.signal) {
  let out = '';
  let err = '';
  const done = main(['watch', '--config', config, ...args], {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    createServer: () => chain,
    ...(signal === undefined ? {} : { signal }),
  });
  return { done, out: () => out, lines: () => out.split('\n').filter((line) => line !== ''), err: () => err };
}

describe('watch', () => {
  it('prints the first status, each later change, and stops cleanly on abort', async () => {
    const watch = startWatch();
    await vi.waitFor(() => expect(watch.out()).toContain('pending -> supported'));
    expect(watch.lines()[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z vault: pending -> supported {2}[0-9a-f]{64} \(v1\.0\.0\)$/);
    expect(watch.lines()[0]).toContain(V1);
    expect(watch.err()).toContain('Watching 1 contract(s). Press Ctrl+C to stop.');

    // Nothing is printed while nothing changes.
    await vi.advanceTimersByTimeAsync(ONE_POLL * 3);
    expect(watch.lines()).toHaveLength(1);

    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(watch.lines()).toHaveLength(2);
    expect(watch.lines()[1]).toContain(`vault: supported -> unsupported  live code ${V2} is not in the supported list`);

    chain.setWasm(VAULT, V1);
    await vi.advanceTimersByTimeAsync(ONE_POLL);
    expect(watch.lines()[2]).toContain('vault: unsupported -> supported');

    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
    expect(vi.getTimerCount()).toBe(0);
    const checks = chain.lookupCalls.length;
    await vi.advanceTimersByTimeAsync(ONE_POLL * 5);
    expect(chain.lookupCalls.length).toBe(checks);
  });

  it('prints one JSON object per change with --json', async () => {
    const watch = startWatch(['--json']);
    await vi.waitFor(() => expect(watch.lines().length).toBeGreaterThan(0));
    chain.setWasm(VAULT, V2);
    await vi.advanceTimersByTimeAsync(ONE_POLL);

    const [first, second] = watch.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({ contract: 'vault', from: 'pending', to: 'supported', liveWasmHash: V1, matchedLabel: 'v1.0.0' });
    expect(first).not.toHaveProperty('reason');
    expect(second).toMatchObject({
      contract: 'vault',
      from: 'supported',
      to: 'unsupported',
      liveWasmHash: V2,
      reason: `live code ${V2} is not in the supported list`,
    });
    expect(new Date(second?.['time'] as string).toISOString()).toBe(second?.['time']);
    expect(watch.err()).toBe('');

    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('reports a contract whose first lookup fails, then its recovery', async () => {
    chain.failLookups = new Error('rpc down');
    const watch = startWatch();
    await vi.waitFor(() => expect(watch.out()).toContain('vault: pending -> pending'));
    expect(watch.out()).toContain('last error: rpc down');

    chain.failLookups = undefined;
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(watch.out()).toContain('vault: pending -> supported');

    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('reports a contract that does not exist', async () => {
    chain.remove(VAULT);
    const watch = startWatch();
    await vi.waitFor(() => expect(watch.out()).toContain('vault: pending -> missing'));
    stop.abort();
    await expect(watch.done).resolves.toBe(EXIT_OK);
  });

  it('exits 2 without watching when the RPC serves a different network', async () => {
    chain.passphrase = 'Public Global Stellar Network ; September 2015';
    const watch = startWatch();
    await expect(watch.done).resolves.toBe(EXIT_ERROR);
    expect(watch.err()).toContain('Public Global Stellar Network');
    expect(chain.lookupCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exits 2 when the network cannot be reached', async () => {
    chain.failNetwork = new Error('connection refused');
    const watch = startWatch();
    await expect(watch.done).resolves.toBe(EXIT_ERROR);
    expect(watch.err()).toContain('connection refused');
  });

  it('reports startup errors as JSON with --json', async () => {
    chain.failNetwork = new Error('offline');
    const watch = startWatch(['--json']);
    await expect(watch.done).resolves.toBe(EXIT_ERROR);
    expect(JSON.parse(watch.out())).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('exits 2 for a missing config', async () => {
    let err = '';
    const code = await main(['watch', '--config', join(dir, 'absent.json')], {
      stdout: () => undefined,
      stderr: (text) => (err += text),
      createServer: () => chain,
      signal: stop.signal,
    });
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain('Cannot read config file');
  });

  it('stops straight away when it is already aborted', async () => {
    stop.abort();
    const watch = startWatch();
    await expect(watch.done).resolves.toBe(EXIT_OK);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects extra arguments', async () => {
    let err = '';
    const code = await main(['watch', 'vault'], { stdout: () => undefined, stderr: (text) => (err += text), signal: stop.signal });
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain('Usage: wasmward watch');
  });

  it('refuses to run without a way to stop', async () => {
    let err = '';
    const code = await main(['watch', '--config', config], {
      stdout: () => undefined,
      stderr: (text) => (err += text),
      createServer: () => chain,
    });
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain('needs a signal');
  });

  it('is listed in the usage text', async () => {
    let out = '';
    await main(['--help'], { stdout: (text) => (out += text), stderr: () => undefined });
    expect(out).toContain('wasmward watch');
    expect(out).toContain('Ctrl+C');
  });
});
