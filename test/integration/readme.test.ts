import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Runs the first JavaScript example in README.md exactly as written, against Stellar testnet, using the
 * built package. It needs network access and `pnpm build`, but not the fixture deploy.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const example = /```js\n([\s\S]*?)\n```/.exec(readme)?.[1];

describe('README example', () => {
  it('is present, and the package it imports has been built', () => {
    expect(example).toContain("from '@wasmward/core'");
    expect(existsSync(new URL('../../dist/index.js', import.meta.url))).toBe(true);
  });

  it('runs as written and exits cleanly', async () => {
    // The file sits inside the package, so `@wasmward/core` resolves to this package by its own name.
    const file = fileURLToPath(new URL('../../readme-example.tmp.mjs', import.meta.url));
    await writeFile(file, `${example ?? ''}\n`);
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [file], { cwd: root, timeout: 90_000 }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
        });
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      // It reports the guard's health whether or not the test contract is still live.
      expect(result.stdout).toContain('checkedAt');
      expect(result.stdout).toMatch(/vault: pending -> /);
    } finally {
      await rm(file, { force: true });
    }
  }, 120_000);
});
