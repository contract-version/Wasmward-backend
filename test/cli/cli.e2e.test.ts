import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeChain, PASSPHRASE } from '../fixtures/chain.js';
import { contractIdOf, hashOf } from '../fixtures/ledger.js';
import { startRpcServer, type RunningRpc } from '../fixtures/rpc-server.js';

/**
 * These tests run the built binary, `dist/cli.js`, as a separate process, the way a deploy pipeline
 * would. Run `pnpm build` first.
 */
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const VAULT = contractIdOf(1);
const V1 = hashOf(1);
const V2 = hashOf(2);
const WASM_B = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2]);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<Result> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolveRun({ code, stdout, stderr });
    });
  });
}

let dir: string;
let chain: FakeChain;
let rpc: RunningRpc;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} does not exist. Run "pnpm build" before the CLI tests.`);
  dir = await mkdtemp(join(tmpdir(), 'wasmward-e2e-'));
  chain = new FakeChain();
  rpc = await startRpcServer(chain);
});

afterAll(async () => {
  await rpc.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(async () => {
  chain.passphrase = PASSPHRASE;
  chain.failLookups = undefined;
  chain.setWasm(VAULT, V1);
  await writeFile(
    join(dir, 'wasmward.json'),
    JSON.stringify({
      version: 1,
      network: { rpcUrl: rpc.url, passphrase: PASSPHRASE },
      contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] } },
    }),
  );
});

// Starting Node and loading the Stellar SDK can take several seconds on a slow disk.
describe('the built CLI', { timeout: 90_000 }, () => {
  it('starts with a Node shebang', async () => {
    expect((await readFile(CLI, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('hash prints the SHA-256 and exits 0', async () => {
    await writeFile(join(dir, 'b.wasm'), WASM_B);
    const result = await runCli(['hash', 'b.wasm'], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${createHash('sha256').update(WASM_B).digest('hex')}\n`);
  });

  it('hash exits 2 for a missing file', async () => {
    const result = await runCli(['hash', 'missing.wasm'], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Cannot read');
  });

  it('exits 2 and prints usage with no command', async () => {
    const result = await runCli([], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('check exits 0 when every contract is supported, using ./wasmward.json by default', async () => {
    const result = await runCli(['check'], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('vault  supported (v1.0.0)');
  });

  it('check exits 1 after the contract is upgraded, then 0 once the new build is added with add', async () => {
    // The contract is upgraded to a build the app has never heard of.
    const upgradedHash = createHash('sha256').update(WASM_B).digest('hex');
    chain.setWasm(VAULT, upgradedHash);
    const blocked = await runCli(['check'], dir);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toContain(`live code ${upgradedHash} is not in the supported list`);

    // The deploy pipeline adds the new build to the app config, and the same check now passes.
    await writeFile(join(dir, 'next.wasm'), WASM_B);
    const added = await runCli(['add', 'vault', 'next.wasm', '--label', 'v2.0.0'], dir);
    expect(added.code).toBe(0);
    const open = await runCli(['check'], dir);
    expect(open.code).toBe(0);
    expect(open.stdout).toContain('supported (v2.0.0)');
  });

  it('check --json prints the report and sets the exit code', async () => {
    chain.setWasm(VAULT, V2);
    const result = await runCli(['check', '--json'], dir);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      exitCode: 1,
      contracts: { vault: { status: 'unsupported', liveWasmHash: V2 } },
    });
  });

  it('check exits 2 on a network passphrase mismatch', async () => {
    chain.passphrase = 'Public Global Stellar Network ; September 2015';
    const result = await runCli(['check'], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Public Global Stellar Network');
  });

  it('check exits 2 when the lookup fails', async () => {
    chain.failLookups = new Error('node unavailable');
    const result = await runCli(['check'], dir);
    expect(result.code).toBe(2);
  });

  it('check exits 2 when there is no config', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'wasmward-empty-'));
    try {
      const result = await runCli(['check'], empty);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Cannot read config file');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('check succeeds through a fallback endpoint when the primary is unreachable', async () => {
    // Nothing listens on port 1, so the primary fails at once; the fallback is the fake RPC server.
    await writeFile(
      join(dir, 'fallback.json'),
      JSON.stringify({
        version: 1,
        network: { rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [rpc.url], passphrase: PASSPHRASE },
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] } },
      }),
    );
    const result = await runCli(['check', '--json', '--config', 'fallback.json'], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      network: { verified: true, usingFallback: true },
      contracts: { vault: { status: 'supported', liveWasmHash: V1 } },
    });
  });

  it('check exits 2 when the primary and the fallback are both unreachable', async () => {
    await writeFile(
      join(dir, 'all-down.json'),
      JSON.stringify({
        version: 1,
        network: { rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: ['http://127.0.0.1:2'], passphrase: PASSPHRASE },
        contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
      }),
    );
    const result = await runCli(['check', '--config', 'all-down.json'], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('all 2 RPC endpoints failed');
  });

  describe('with a config that has several networks', () => {
    const MAINNET = 'Public Global Stellar Network ; September 2015';

    async function writeMulti(name: string): Promise<void> {
      // Both sections use the one fake RPC, which serves the test network. The "mainnet" section expects the
      // public network, so it must be caught rather than trusted.
      const contracts = { vault: { contractId: VAULT, supported: [{ wasmHash: V1, label: 'v1.0.0' }] } };
      await writeFile(
        join(dir, name),
        JSON.stringify({
          version: 1,
          networks: {
            testnet: { network: { rpcUrl: rpc.url, passphrase: PASSPHRASE }, contracts },
            mainnet: { network: { rpcUrl: rpc.url, passphrase: MAINNET }, contracts },
          },
        }),
      );
    }

    it('check catches a network whose RPC serves a different one, and exits 2', async () => {
      await writeMulti('multi.json');
      const result = await runCli(['check', '--json', '--config', 'multi.json'], dir);
      expect(result.code).toBe(2);
      const json = JSON.parse(result.stdout);
      expect(json.networks.testnet).toMatchObject({ ok: true, exitCode: 0 });
      expect(json.networks.mainnet).toMatchObject({ ok: false, exitCode: 2 });
      expect(json.networks.mainnet.error).toContain(`config expects "${MAINNET}"`);
    });

    it('check --network passes for the network that matches', async () => {
      await writeMulti('multi-ok.json');
      const result = await runCli(['check', '--network', 'testnet', '--config', 'multi-ok.json'], dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('vault  supported (v1.0.0)');
    });

    it('add refuses to guess the network, then edits only the one you name', async () => {
      await writeMulti('multi-add.json');
      await writeFile(join(dir, 'd.wasm'), new Uint8Array([4, 4, 4]));
      const guess = await runCli(['add', 'vault', 'd.wasm', '--label', 'v9', '--config', 'multi-add.json'], dir);
      expect(guess.code).toBe(2);
      expect(guess.stderr).toContain('choose one with --network');

      const named = await runCli(['add', 'vault', 'd.wasm', '--network', 'mainnet', '--label', 'v9', '--config', 'multi-add.json'], dir);
      expect(named.code).toBe(0);
      const saved = JSON.parse(await readFile(join(dir, 'multi-add.json'), 'utf8'));
      expect(saved.networks.mainnet.contracts.vault.supported).toHaveLength(2);
      expect(saved.networks.testnet.contracts.vault.supported).toHaveLength(1);
    });
  });

  it('init creates a config from the live code, check then passes on it, and init will not overwrite it', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'wasmward-init-e2e-'));
    try {
      const created = await runCli(
        ['init', 'vault', VAULT, '--rpc-url', rpc.url, '--passphrase', PASSPHRASE, '--label', 'first'],
        fresh,
      );
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(`'vault' supports first (${V1})`);
      expect(created.stderr).toContain('trusts the RPC');

      const saved = JSON.parse(await readFile(join(fresh, 'wasmward.json'), 'utf8'));
      expect(saved.contracts.vault.supported).toEqual([{ wasmHash: V1, label: 'first' }]);

      const checked = await runCli(['check'], fresh);
      expect(checked.code).toBe(0);
      expect(checked.stdout).toContain('vault  supported (first)');

      const again = await runCli(
        ['init', 'vault', VAULT, '--rpc-url', rpc.url, '--passphrase', PASSPHRASE],
        fresh,
      );
      expect(again.code).toBe(2);
      expect(again.stderr).toContain('already exists');
    } finally {
      await rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('init --wasm needs no network at all', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'wasmward-init-offline-'));
    try {
      await writeFile(join(fresh, 'b.wasm'), WASM_B);
      // Nothing listens on port 1: a network call would fail, so success proves there was none.
      const result = await runCli(
        ['init', 'vault', VAULT, '--rpc-url', 'http://127.0.0.1:1', '--passphrase', PASSPHRASE, '--wasm', 'b.wasm', '--json'],
        fresh,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        source: 'wasm-file',
        wasmHash: createHash('sha256').update(WASM_B).digest('hex'),
      });
    } finally {
      await rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('check against an RPC that never answers gives up and exits, instead of hanging', async () => {
    // Without a transport timeout the abandoned request keeps its connection open, and the process stays
    // alive after it has already printed its answer. A deploy gate would then hang.
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(
        join(dir, 'silent.json'),
        JSON.stringify({
          version: 1,
          network: { rpcUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, passphrase: PASSPHRASE },
          pollIntervalMs: 5_000, // so a request may take up to 5 s
          contracts: { vault: { contractId: VAULT, supported: [{ wasmHash: V1 }] } },
        }),
      );
      const startedAt = Date.now();
      const result = await runCli(['check', '--config', 'silent.json'], dir);
      const seconds = (Date.now() - startedAt) / 1000;
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('timed out after 5000ms');
      // 5 s timeout, 1 s slack, plus starting Node and loading the SDK. Far short of "never".
      expect(seconds).toBeLessThan(30);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 60_000);

  it('add updates the default config file and refuses a duplicate', async () => {
    await writeFile(join(dir, 'c.wasm'), new Uint8Array([7, 7, 7]));
    const first = await runCli(['add', 'vault', 'c.wasm', '--label', 'v3'], dir);
    expect(first.code).toBe(0);
    const saved = JSON.parse(await readFile(join(dir, 'wasmward.json'), 'utf8'));
    expect(saved.contracts.vault.supported).toHaveLength(2);
    const again = await runCli(['add', 'vault', 'c.wasm', '--label', 'v3'], dir);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already supported');
  });
});
