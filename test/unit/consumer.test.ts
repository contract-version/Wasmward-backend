import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Installs the packed package, exactly as `npm pack` would publish it, into a throwaway project and uses it
 * the three ways people will: `import`, `require`, and from TypeScript under Node's module resolution.
 * It needs `pnpm build` first. The peer dependencies resolve from this repository's node_modules.
 */
const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

let project: string;

/** Unpacks an npm tarball (gzipped ustar) into a folder, dropping the top-level "package" directory. */
async function extractTarball(tarball: string, into: string): Promise<void> {
  const data = gunzipSync(await readFile(tarball));
  const text = (start: number, length: number): string => {
    const field = data.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? length : end).toString('utf8');
  };
  for (let offset = 0; offset + 512 <= data.length; ) {
    const name = text(offset, 100);
    if (name === '') break; // the end-of-archive blocks are empty
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1);
    const prefix = text(offset + 345, 155);
    const fullName = prefix === '' ? name : prefix + '/' + name;
    const body = data.subarray(offset + 512, offset + 512 + size);
    if (type === '0' || type === '') {
      const relative = fullName.split('/').slice(1).join('/');
      const target = join(into, relative);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

async function node(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, args, { cwd: project, timeout: 120_000 });
}

beforeAll(async () => {
  project = await mkdtemp(join(repo, '.consumer-'));
  const pack = await run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', project], { cwd: repo, shell });
  const [packed] = JSON.parse(pack.stdout) as { filename: string }[];
  const installed = join(project, 'node_modules', '@wasmward', 'core');
  await mkdir(installed, { recursive: true });
  await extractTarball(join(project, packed?.filename ?? ''), installed);

  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

  const sample = `{
    version: 1,
    network: { rpcUrl: 'https://rpc.example.org', passphrase: 'Test SDF Network ; September 2015' },
    contracts: { vault: { contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', supported: [{ wasmHash: 'ab'.repeat(32), label: 'v1' }] } },
  }`;

  await writeFile(
    join(project, 'esm.mjs'),
    `import * as core from '@wasmward/core';
import { loadConfigFile, loadConfigDocumentFile } from '@wasmward/core/node';
const config = core.loadConfig(${sample});
const guard = core.createVersionGuard(config);
console.log(JSON.stringify({
  entry: 'esm',
  functions: ['loadConfig', 'createVersionGuard', 'hashWasm', 'fetchExecutables', 'createPoller', 'createRpcClient'].map((n) => typeof core[n]),
  classes: [typeof core.ConfigError, typeof core.WriteBlockedError],
  node: [typeof loadConfigFile, typeof loadConfigDocumentFile],
  hash: await core.hashWasm(new TextEncoder().encode('abc')),
  status: guard.status().vault.status,
  pollDefault: config.pollIntervalMs,
}));
`,
  );
  await writeFile(
    join(project, 'cjs.cjs'),
    `const core = require('@wasmward/core');
const node = require('@wasmward/core/node');
const config = core.loadConfig(${sample});
const guard = core.createVersionGuard(config);
core.hashWasm(new TextEncoder().encode('abc')).then((hash) => {
  console.log(JSON.stringify({
    entry: 'cjs',
    functions: ['loadConfig', 'createVersionGuard', 'hashWasm', 'fetchExecutables', 'createPoller', 'createRpcClient'].map((n) => typeof core[n]),
    classes: [typeof core.ConfigError, typeof core.WriteBlockedError],
    node: [typeof node.loadConfigFile, typeof node.loadConfigDocumentFile],
    hash,
    status: guard.status().vault.status,
    pollDefault: config.pollIntervalMs,
  }));
});
`,
  );

  // TypeScript sources. The @ts-expect-error lines prove the types resolved: if they came back as "any",
  // those lines would stop being errors and the compile would fail.
  const typed = (importLine: string, nodeImportLine: string) => `${importLine}
${nodeImportLine}

const input = ${sample};
const config: WasmwardConfig = loadConfig(input);
const polling: number = config.pollIntervalMs;
const guard: VersionGuard = createVersionGuard(config);
const state: ContractState | undefined = guard.status()['vault'];
const status: Status | undefined = state?.status;
const load: (path: string) => Promise<WasmwardConfig> = loadConfigFile;
const hash: Promise<string> = hashWasm(new Uint8Array(0));

guard.subscribe((change) => {
  const to: Status = change.to;
  console.log(to);
});

try {
  guard.assertWritable('vault');
} catch (error) {
  if (error instanceof WriteBlockedError) {
    const why: string = error.reason;
    console.log(why, polling, status, load, hash);
  }
}

// @ts-expect-error status is a string union, not a number
const wrong: number = guard.status()['vault']?.status;
// @ts-expect-error there is no such option
loadConfig(input, { nope: true });
// @ts-expect-error contract names are strings
guard.isWritable(42);
console.log(wrong);
`;
  await writeFile(
    join(project, 'types-esm.mts'),
    typed(
      "import { createVersionGuard, hashWasm, loadConfig, WriteBlockedError, type ContractState, type Status, type VersionGuard, type WasmwardConfig } from '@wasmward/core';",
      "import { loadConfigFile } from '@wasmward/core/node';",
    ),
  );
  await writeFile(
    join(project, 'types-cjs.cts'),
    typed(
      "import { createVersionGuard, hashWasm, loadConfig, WriteBlockedError, type ContractState, type Status, type VersionGuard, type WasmwardConfig } from '@wasmward/core';",
      "import { loadConfigFile } from '@wasmward/core/node';",
    ),
  );
  await writeFile(
    join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'node16',
        moduleResolution: 'node16',
        target: 'es2022',
        lib: ['es2022', 'dom'],
        // The SDK's own declarations are not what is under test.
        skipLibCheck: true,
        types: [],
      },
      include: ['types-esm.mts', 'types-cjs.cts'],
    }),
  );
}, 180_000);

afterAll(async () => {
  // A folder briefly locked by an indexer or virus scanner must not fail the run; it is git-ignored.
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
});

const EXPECTED_FUNCTIONS = ['function', 'function', 'function', 'function', 'function', 'function'];

// Loading the Stellar SDK takes several seconds on a slow disk, and every case here starts a process.
describe('the packed package, installed into a fresh project', { timeout: 120_000 }, () => {
  it('holds only what was meant to be published', async () => {
    const installed = join(project, 'node_modules', '@wasmward', 'core');
    expect((await readdir(installed)).sort()).toEqual(['LICENSE', 'README.md', 'dist', 'package.json']);
  });

  it('works with import, and its defaults and a hash are right', async () => {
    const { stdout } = await node(['esm.mjs']);
    expect(JSON.parse(stdout)).toEqual({
      entry: 'esm',
      functions: EXPECTED_FUNCTIONS,
      classes: ['function', 'function'],
      node: ['function', 'function'],
      hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      status: 'pending',
      pollDefault: 30_000,
    });
  });

  it('works with require, giving the same answers', async () => {
    const { stdout } = await node(['cjs.cjs']);
    expect(JSON.parse(stdout)).toEqual({
      entry: 'cjs',
      functions: EXPECTED_FUNCTIONS,
      classes: ['function', 'function'],
      node: ['function', 'function'],
      hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      status: 'pending',
      pollDefault: 30_000,
    });
  });

  it('type-checks from TypeScript, for both an ES module and a CommonJS file, and the types are not "any"', async () => {
    const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = await run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: project, timeout: 180_000 }).catch(
      (error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? 'failed' }),
    );
    expect(`${result.stdout}${result.stderr}`.trim()).toBe('');
  });

  it('runs the command line tool from the installed package', async () => {
    const cli = join(project, 'node_modules', '@wasmward', 'core', 'dist', 'cli.js');
    const { stdout } = await node([cli, 'hash', join(project, 'package.json'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ wasmHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const help = await node([cli, '--help']);
    expect(help.stdout).toContain('wasmward init');
  });
});
