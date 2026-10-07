import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const realRename = (await vi.importActual<typeof fs>('node:fs/promises')).rename;
const renameMock = vi.mocked(fs.rename);

const CONTRACT = StrKey.encodeContract(new Uint8Array(32).fill(5));
const ORIGINAL = `${JSON.stringify(
  {
    version: 1,
    network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
    contracts: { vault: { contractId: CONTRACT, supported: [{ wasmHash: 'ab'.repeat(32), label: 'v1' }] } },
  },
  null,
  2,
)}\n`;

let dir: string;
let config: string;
let wasm: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-atomic-'));
  config = join(dir, 'wasmward.json');
  wasm = join(dir, 'next.wasm');
  await writeFile(wasm, new Uint8Array([1, 2, 3, 4]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function add(): Promise<{ code: number; err: string }> {
  let err = '';
  const code = await main(['add', 'vault', wasm, '--label', 'v2', '--config', config], {
    stdout: () => undefined,
    stderr: (text) => (err += text),
  });
  return { code, err };
}

describe('add writes atomically', () => {
  it('leaves the original file and no temporary file when the final rename fails', async () => {
    await writeFile(config, ORIGINAL);
    renameMock.mockRejectedValueOnce(new Error('disk full'));

    const result = await add();

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('disk full');
    expect(await readFile(config, 'utf8')).toBe(ORIGINAL);
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });

  it('changes the target only at the final rename, never partway', async () => {
    await writeFile(config, ORIGINAL);
    const seen: { targetBefore?: string; tempContent?: string; tempName?: string } = {};
    renameMock.mockImplementationOnce(async (from, to) => {
      seen.targetBefore = await readFile(to, 'utf8');
      seen.tempName = String(from);
      seen.tempContent = await readFile(from, 'utf8');
      return realRename(from, to);
    });

    const result = await add();

    expect(result.code).toBe(EXIT_OK);
    // While the new content was fully written to the temp file, the real file still held the old content.
    expect(seen.targetBefore).toBe(ORIGINAL);
    expect(seen.tempName).toContain('.wasmward.tmp');
    expect(JSON.parse(seen.tempContent ?? '{}').contracts.vault.supported).toHaveLength(2);
    // The temp file lives next to the target so the rename stays on one filesystem.
    expect(seen.tempName?.startsWith(dir)).toBe(true);
    // After the rename the target has the new content and the temp file is gone.
    expect(JSON.parse(await readFile(config, 'utf8')).contracts.vault.supported).toHaveLength(2);
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });
});
