import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface PackageJson {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, Record<string, Record<string, string>> | string>;
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageJson;

/** These tests inspect the build output, so run `pnpm build` first. */
describe('published package', () => {
  it('contains only dist, README.md, LICENSE and package.json', async () => {
    const { stdout } = await run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      shell: process.platform === 'win32',
    });
    const [packed] = JSON.parse(stdout) as { files: { path: string }[] }[];
    const paths = (packed?.files ?? []).map((file) => file.path);

    expect(paths.length).toBeGreaterThan(5);
    const unexpected = paths.filter(
      (path) => !path.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(path),
    );
    expect(unexpected).toEqual([]);
    for (const required of ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/cli.js']) {
      expect(paths, `${required} is missing`).toContain(required);
    }
  }, 120_000);

  it('points bin and exports at files the build produces', () => {
    expect(pkg.bin['wasmward']).toBe('./dist/cli.js');
    const targets = new Set<string>([pkg.bin['wasmward'] ?? '']);
    const collect = (value: unknown): void => {
      if (typeof value === 'string') targets.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(pkg.exports);
    for (const target of targets) {
      if (target === './package.json') continue;
      expect(existsSync(new URL(`../../${target}`, import.meta.url)), `${target} was not built`).toBe(true);
    }
  });

  it('ships the CLI with a Node shebang', () => {
    expect(readFileSync(new URL('../../dist/cli.js', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is version 0.1.0 and exposes both entry points', () => {
    expect(pkg.name).toBe('@wasmward/core');
    expect(pkg.version).toBe('0.1.0');
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining(['.', './node']));
  });
});
