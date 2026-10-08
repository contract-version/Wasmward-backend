import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Keypair, StrKey, rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchExecutables } from '../../src/fetch.js';
import { createVersionGuard, type VersionGuard } from '../../src/guard.js';
import { hashWasm } from '../../src/hash.js';
import { WriteBlockedError } from '../../src/errors.js';
import type { WasmwardConfigInput } from '../../src/types.js';
import { loadFixtureEnvironment, upgradeContract, type FixtureEnvironment } from './fixture.js';

/**
 * Runs the guard against a real contract on Stellar testnet through a real upgrade.
 * Skipped, with the reason printed, when the fixture has not been deployed.
 */
const POLL_MS = 5_000; // the smallest interval the config allows
const MAX_STALENESS_MS = 30_000;
const JITTER = 1.1;
/** Time allowed for one lookup to travel to and from the RPC, on top of two poll intervals. */
const LOOKUP_ALLOWANCE_MS = 5_000;

const loaded = loadFixtureEnvironment();
if ('reason' in loaded) {
  console.warn(`[integration] skipped: ${loaded.reason}`);
}

function configFor(env: FixtureEnvironment, contractId: string, hashes: string[]): WasmwardConfigInput {
  return {
    version: 1,
    network: { rpcUrl: env.fixture.rpcUrl, passphrase: env.fixture.passphrase },
    pollIntervalMs: POLL_MS,
    maxStalenessMs: MAX_STALENESS_MS,
    contracts: { vault: { contractId, supported: hashes.map((wasmHash, i) => ({ wasmHash, label: `v${i + 1}` })) } },
  };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return Date.now() - startedAt;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe.runIf('env' in loaded)('testnet upgrade flow', () => {
  const env = (loaded as { env: FixtureEnvironment }).env;
  const server = new rpc.Server(env.fixture.rpcUrl);
  const guards: VersionGuard[] = [];

  async function liveHash(): Promise<string | undefined> {
    const result = (await fetchExecutables(server, [env.fixture.contractId], 15_000)).get(env.fixture.contractId);
    return result?.kind === 'wasm' ? result.wasmHash : undefined;
  }

  async function makeGuard(config: WasmwardConfigInput): Promise<VersionGuard> {
    const guard = createVersionGuard(config);
    guards.push(guard);
    await guard.start();
    return guard;
  }

  beforeAll(async () => {
    // A failed earlier run may have left the contract on v2. Start every run from v1.
    if ((await liveHash()) !== env.fixture.v1.wasmHash) await upgradeContract(server, env, env.fixture.v1.wasmHash);
    expect(await liveHash()).toBe(env.fixture.v1.wasmHash);
  }, 120_000);

  afterAll(async () => {
    for (const guard of guards) await guard.stop();
    // Leave the fixture on v1 so the next run, or the next person, starts clean.
    if ((await liveHash()) !== env.fixture.v1.wasmHash) await upgradeContract(server, env, env.fixture.v1.wasmHash);
  }, 120_000);

  it('hashes the fixture builds exactly as Stellar does on upload', async () => {
    const v1 = await readFile(resolve(env.dir, env.fixture.v1.file));
    const v2 = await readFile(resolve(env.dir, env.fixture.v2.file));
    expect(await hashWasm(new Uint8Array(v1))).toBe(env.fixture.v1.wasmHash);
    expect(await hashWasm(new Uint8Array(v2))).toBe(env.fixture.v2.wasmHash);
    expect(env.fixture.v1.wasmHash).not.toBe(env.fixture.v2.wasmHash);
  });

  it('reports the on-chain Wasm hash of the deployed instance', async () => {
    const result = (await fetchExecutables(server, [env.fixture.contractId], 15_000)).get(env.fixture.contractId);
    expect(result).toMatchObject({ kind: 'wasm', wasmHash: env.fixture.v1.wasmHash });
  });

  it(
    'blocks writes within two poll intervals of an upgrade, and allows them again once v2 is supported',
    async () => {
      // Only v1 is supported.
      const guard = await makeGuard(configFor(env, env.fixture.contractId, [env.fixture.v1.wasmHash]));
      expect(guard.status()['vault']?.status).toBe('supported');
      expect(() => guard.assertWritable('vault')).not.toThrow();

      // The contract is upgraded to v2 on chain. Note when the guard first reports it.
      let sawUnsupportedAt: number | undefined;
      guard.subscribe((change) => {
        if (change.to === 'unsupported') sawUnsupportedAt = Date.now();
      });
      await upgradeContract(server, env, env.fixture.v2.wasmHash);
      const confirmedAt = Date.now();
      await waitFor(() => sawUnsupportedAt !== undefined, 2 * POLL_MS * JITTER + LOOKUP_ALLOWANCE_MS);

      // Measured on the local clock from when the upgrade was confirmed. Negative means the poller had
      // already noticed it while the confirmation was still being awaited.
      const detectionMs = (sawUnsupportedAt ?? Number.POSITIVE_INFINITY) - confirmedAt;
      console.info(`[integration] guard noticed the upgrade ${detectionMs}ms after it was confirmed (poll interval ${POLL_MS}ms)`);
      expect(detectionMs).toBeLessThan(2 * POLL_MS * JITTER + LOOKUP_ALLOWANCE_MS);

      expect(guard.status()['vault']?.liveWasmHash).toBe(env.fixture.v2.wasmHash);
      expect(guard.isWritable('vault')).toBe(false);
      const error = (() => {
        try {
          guard.assertWritable('vault');
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(WriteBlockedError);
      expect((error as WriteBlockedError).liveWasmHash).toBe(env.fixture.v2.wasmHash);
      await expect(guard.assertWritableFresh('vault')).rejects.toBeInstanceOf(WriteBlockedError);
      await guard.stop();

      // The app ships a build that supports v2, and a new guard agrees.
      const updated = await makeGuard(
        configFor(env, env.fixture.contractId, [env.fixture.v1.wasmHash, env.fixture.v2.wasmHash]),
      );
      expect(updated.status()['vault']).toMatchObject({ status: 'supported', matchedLabel: 'v2' });
      expect(() => updated.assertWritable('vault')).not.toThrow();
      await expect(updated.assertWritableFresh('vault')).resolves.toBeUndefined();
    },
    180_000,
  );

  it('reports a valid but nonexistent contract as missing and blocks writes', async () => {
    const random = StrKey.encodeContract(Keypair.random().rawPublicKey());
    const guard = await makeGuard(configFor(env, random, [env.fixture.v1.wasmHash]));
    expect(guard.status()['vault']?.status).toBe('missing');
    expect(guard.isWritable('vault')).toBe(false);
    expect(() => guard.assertWritable('vault')).toThrow(/no contract instance was found/);
    await guard.stop();
  });
});
