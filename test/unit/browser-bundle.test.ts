import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';

/**
 * The main entry must bundle for a browser: no `fs`, no `path`, no other Node built-in. The bundler keeps
 * Node built-ins as external imports and drops the `node:` prefix, so the test lists the built-ins the
 * output still imports. The same helper runs on the Node-only entry as a control, to show it can fail.
 */
async function bundleForBrowser(entry: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'wasmward-browser-'));
  try {
    await build({
      config: false,
      entry: { bundle: entry },
      platform: 'browser',
      format: 'esm',
      noExternal: [/.*/],
      outDir,
      dts: false,
      silent: true,
      splitting: false,
    });
    const files = (await readdir(outDir)).filter((name) => name.endsWith('.js'));
    return (await Promise.all(files.map((name) => readFile(join(outDir, name), 'utf8')))).join('\n');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Node built-in modules the bundle still imports, as `from "x"`, `import("x")` or `require("x")`. */
function importedBuiltins(code: string): string[] {
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
  const found = new Set<string>();
  for (const match of code.matchAll(/(?:from|import\(|require\()\s*["']([^"']+)["']/g)) {
    const specifier = (match[1] ?? '').replace(/^node:/, '');
    if (builtins.has(specifier)) found.add(specifier);
  }
  return [...found].sort();
}

describe('browser bundle', () => {
  it('bundles the main entry for a browser without any Node built-in', async () => {
    const code = await bundleForBrowser('src/index.ts');
    expect(code.length).toBeGreaterThan(10_000);
    expect(importedBuiltins(code)).toEqual([]);
  }, 120_000);

  it('control: the Node-only entry does import fs, so the check can fail', async () => {
    const code = await bundleForBrowser('src/node.ts');
    expect(importedBuiltins(code)).toContain('fs/promises');
  }, 120_000);

  it('control: the helper recognises the usual spellings', () => {
    expect(importedBuiltins('import { a } from "node:fs"; const b = require("path"); import("os");')).toEqual([
      'fs',
      'os',
      'path',
    ]);
    expect(importedBuiltins('import { z } from "zod"; from "not-a-builtin"')).toEqual([]);
  });
});
