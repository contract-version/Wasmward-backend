import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_NOT_SUPPORTED, EXIT_OK, main } from '../../src/cli-core.js';
import { EXPIRY_WARNING_LEDGERS } from '../../src/state.js';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';

const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const V2 = hashOf(2);

let dir: string;
let config: string;
let chain: FakeChain;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-expiry-'));
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

beforeEach(() => {
  chain = new FakeChain();
  chain.setWasm(VAULT, V1);
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

describe('check shows how long a contract has left', () => {
  it('says so, and nudges, when under about a week remains', async () => {
    chain.ttl = 5_000; // about 7 hours
    const { code, out } = await check();
    expect(code).toBe(EXIT_OK);
    expect(out).toContain(`vault  supported (v1)  ${V1}  (expires in about 7 hours; extend its lifetime soon)`);
  });

  it('says so without a nudge when there is plenty of time', async () => {
    chain.ttl = 200_000; // about 11.6 days
    const { out } = await check();
    expect(out).toContain(`supported (v1)  ${V1}  (expires in about 12 days)`);
    expect(out).not.toContain('extend');
  });

  it('starts nudging exactly below the threshold', async () => {
    chain.ttl = EXPIRY_WARNING_LEDGERS;
    expect((await check()).out).toContain('(expires in about 7 days)');
    chain.ttl = EXPIRY_WARNING_LEDGERS - 1;
    expect((await check()).out).toContain('(expires in about 7 days; extend its lifetime soon)');
  });

  it('counts a few hours and under an hour in the right words', async () => {
    chain.ttl = 100; // 500 s
    expect((await check()).out).toContain('(expires in less than an hour; extend');
    chain.ttl = 20_000; // about 28 hours
    expect((await check()).out).toContain('(expires in about 28 hours; extend');
  });

  it('never changes the result: a contract close to expiry is still supported and exits 0', async () => {
    chain.ttl = 1_000;
    expect((await check()).code).toBe(EXIT_OK);
  });

  it('leaves it off lines for contracts that are not supported', async () => {
    chain.setWasm(VAULT, V2);
    const { code, out } = await check();
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(out).toContain('unsupported');
    expect(out).not.toContain('expires in');
  });

  it('includes ledgersUntilExpiry in the JSON report', async () => {
    chain.ttl = 123_456;
    const { out } = await check(['--json']);
    expect(JSON.parse(out).contracts.vault).toMatchObject({ status: 'supported', ledgersUntilExpiry: 123_456 });
  });

  it('leaves it out of the JSON for a contract that was not found', async () => {
    chain.remove(VAULT);
    const { out } = await check(['--json']);
    expect(JSON.parse(out).contracts.vault).not.toHaveProperty('ledgersUntilExpiry');
  });
});
