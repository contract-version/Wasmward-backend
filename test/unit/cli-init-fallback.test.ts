import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';
import { loadConfig } from '../../src/config.js';
import { contractIdOf } from '../fixtures/ledger.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, link: vi.fn(actual.link), access: vi.fn(actual.access) };
});

const realFs = await vi.importActual<typeof fs>('node:fs/promises');
const linkMock = vi.mocked(fs.link);
const accessMock = vi.mocked(fs.access);
const CONTRACT = contractIdOf(1);

let dir: string;
let wasmFile: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasmward-init-fallback-'));
  wasmFile = join(dir, 'build.wasm');
  await writeFile(wasmFile, new Uint8Array([1, 2, 3, 4]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  linkMock.mockImplementation(realFs.link);
  accessMock.mockImplementation(realFs.access);
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function init(config: string): Promise<{ code: number; err: string }> {
  let err = '';
  const code = await main(['init', 'vault', CONTRACT, '--preset', 'testnet', '--wasm', wasmFile, '--config', config], {
    stdout: () => undefined,
    stderr: (text) => (err += text),
  });
  return { code, err };
}

function target(): string {
  counter += 1;
  return join(dir, `new-${counter}.json`);
}

describe('init on a file system without hard links', () => {
  it('falls back to an exclusive create and still produces a whole, valid file', async () => {
    linkMock.mockRejectedValue(errnoError('EPERM'));
    const config = target();
    const result = await init(config);
    expect(result.code).toBe(EXIT_OK);
    const written: unknown = JSON.parse(await readFile(config, 'utf8'));
    expect(() => loadConfig(written)).not.toThrow();
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });

  it('still refuses to overwrite a file that appeared after the early check', async () => {
    // Pretend the file was not there when init first looked, as in a race with another process.
    accessMock.mockRejectedValue(errnoError('ENOENT'));
    linkMock.mockRejectedValue(errnoError('EPERM'));
    const config = target();
    await writeFile(config, 'precious');
    const result = await init(config);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('already exists. init never overwrites a file');
    expect(await readFile(config, 'utf8')).toBe('precious');
  });
});

describe('init when the file appears between the check and the write', () => {
  it('refuses, because creating a hard link fails if the file exists', async () => {
    accessMock.mockRejectedValue(errnoError('ENOENT'));
    const config = target();
    await writeFile(config, 'precious');
    const result = await init(config);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('already exists. init never overwrites a file');
    expect(await readFile(config, 'utf8')).toBe('precious');
    expect((await readdir(dir)).filter((name) => name.endsWith('.wasmward.tmp'))).toEqual([]);
  });
});
