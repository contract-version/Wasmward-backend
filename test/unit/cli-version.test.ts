import { describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_OK, main } from '../../src/cli-core.js';

async function run(args: string[], version?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(args, { stdout: (text) => (out += text), stderr: (text) => (err += text), version });
  return { code, out, err };
}

describe('--version', () => {
  it('prints the version it was given, on one line, and exits 0', async () => {
    expect(await run(['--version'], '1.2.3')).toEqual({ code: EXIT_OK, out: 'wasmward 1.2.3\n', err: '' });
  });

  it('has the short form -v', async () => {
    expect((await run(['-v'], '1.2.3')).out).toBe('wasmward 1.2.3\n');
  });

  it('prints JSON with --json', async () => {
    const { out } = await run(['--version', '--json'], '1.2.3');
    expect(JSON.parse(out)).toEqual({ version: '1.2.3' });
  });

  it('says "unknown" rather than failing when the entry point gave no version', async () => {
    expect(await run(['--version'])).toEqual({ code: EXIT_OK, out: 'wasmward unknown\n', err: '' });
  });

  it('works without a command and without touching the network or any file', async () => {
    const result = await run(['--version', '--config', '/no/such/file.json'], '0.1.0');
    expect(result.code).toBe(EXIT_OK);
  });

  it('is listed in the help text', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain('-v, --version');
  });

  it('is not accepted with a value', async () => {
    const result = await run(['--version=1']);
    expect(result.code).toBe(EXIT_ERROR);
  });
});
