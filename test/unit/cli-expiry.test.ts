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

describe('check --min-ttl-days', () => {
  const MINIMUM_7_DAYS = EXPIRY_WARNING_LEDGERS; // 7 days is 120,960 ledgers

  it('passes when every supported contract has at least that long left', async () => {
    chain.ttl = 200_000; // about 11.6 days
    const { code, out } = await check(['--min-ttl-days', '7']);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('1 of 1 contracts supported with at least 7 days left.');
  });

  it('fails with exit 1 when a supported contract has less, and says why', async () => {
    chain.ttl = 5_000; // about 7 hours
    const { code, out } = await check(['--min-ttl-days', '1']);
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(out).toContain(`supported (v1)  ${V1}  (expires in about 7 hours: under the 1-day minimum)`);
    expect(out).toContain('0 of 1 contracts supported with at least 1 day left.');
  });

  it('draws the line exactly at the minimum: equal passes, one ledger fewer fails', async () => {
    chain.ttl = MINIMUM_7_DAYS;
    expect((await check(['--min-ttl-days', '7'])).code).toBe(EXIT_OK);
    chain.ttl = MINIMUM_7_DAYS - 1;
    expect((await check(['--min-ttl-days', '7'])).code).toBe(EXIT_NOT_SUPPORTED);
  });

  it('accepts a fraction of a day', async () => {
    chain.ttl = 8_640; // exactly half a day
    expect((await check(['--min-ttl-days', '0.5'])).code).toBe(EXIT_OK);
    chain.ttl = 8_639;
    expect((await check(['--min-ttl-days', '0.5'])).code).toBe(EXIT_NOT_SUPPORTED);
  });

  it('changes nothing when the flag is not given', async () => {
    chain.ttl = 100;
    const { code, out } = await check();
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('1 of 1 contracts supported.');
    expect(out).not.toContain('minimum');
  });

  it('marks the JSON: the contract, the minimum, and an ok that agrees with the exit code', async () => {
    chain.ttl = 5_000;
    const failing = JSON.parse((await check(['--min-ttl-days', '1', '--json'])).out);
    expect(failing).toMatchObject({ ok: false, exitCode: 1, minTtlDays: 1 });
    expect(failing.contracts.vault).toMatchObject({ status: 'supported', belowMinTtl: true, ledgersUntilExpiry: 5_000 });

    chain.ttl = 200_000;
    const passing = JSON.parse((await check(['--min-ttl-days', '1', '--json'])).out);
    expect(passing).toMatchObject({ ok: true, exitCode: 0, minTtlDays: 1 });
    expect(passing.contracts.vault).not.toHaveProperty('belowMinTtl');
  });

  it('leaves the JSON as it was without the flag', async () => {
    const json = JSON.parse((await check(['--json'])).out);
    expect(json).not.toHaveProperty('minTtlDays');
    expect(json.contracts.vault).not.toHaveProperty('belowMinTtl');
  });

  it('does not flag a contract that already fails for another reason', async () => {
    chain.setWasm(VAULT, V2);
    chain.ttl = 100;
    const { code, out } = await check(['--min-ttl-days', '30', '--json']);
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(JSON.parse(out).contracts.vault).not.toHaveProperty('belowMinTtl');
  });

  it('still reports a failed lookup as 2, ahead of 1', async () => {
    chain.failLookups = new Error('rpc down');
    expect((await check(['--min-ttl-days', '3'])).code).toBe(2);
  });

  it.each(['abc', '0', '-1', '', ' ', '40000', 'Infinity', 'NaN'])('rejects the minimum %j before any network work', async (value) => {
    const { code, out } = await check(['--min-ttl-days', value]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(chain.networkCalls).toBe(0);
  });

  it('is refused for commands it does not apply to', async () => {
    let err = '';
    const code = await main(['hash', config, '--min-ttl-days', '3'], { stdout: () => undefined, stderr: (text) => (err += text) });
    expect(code).toBe(2);
    expect(err).toContain('--min-ttl-days only applies to check');
  });

  it('is listed in the usage text', async () => {
    let out = '';
    await main(['--help'], { stdout: (text) => (out += text), stderr: () => undefined });
    expect(out).toContain('--min-ttl-days');
  });

  it('applies to each network of a multi-network file', async () => {
    const soon = new FakeChain();
    soon.setWasm(VAULT, V1);
    soon.ttl = 1_000;
    const plenty = new FakeChain();
    plenty.setWasm(VAULT, V1);
    plenty.ttl = 500_000;
    const file = join(dir, 'multi.json');
    const network = (url: string) => ({
      network: { rpcUrl: url, passphrase: PASSPHRASE },
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
    });
    await writeFile(
      file,
      JSON.stringify({ version: 1, networks: { soon: network('http://127.0.0.1:11'), plenty: network('http://127.0.0.1:12') } }),
    );
    let out = '';
    const code = await main(['check', '--config', file, '--min-ttl-days', '3', '--json'], {
      stdout: (text) => (out += text),
      stderr: () => undefined,
      createServer: (c) => (c.network.rpcUrl.endsWith(':11') ? soon : plenty),
      createFallbackServers: () => [],
    });
    const json = JSON.parse(out);
    expect(code).toBe(EXIT_NOT_SUPPORTED);
    expect(json).toMatchObject({ ok: false, exitCode: 1 });
    expect(json.networks.soon).toMatchObject({ ok: false, exitCode: 1 });
    expect(json.networks.soon.contracts.vault.belowMinTtl).toBe(true);
    expect(json.networks.plenty).toMatchObject({ ok: true, exitCode: 0 });
  });
});
