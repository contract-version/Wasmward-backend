import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli-core.js';

/**
 * The GitHub Action (action.yml at the repository root) is a few dozen lines of YAML that run in other
 * people's workflows with their inputs, so its shape and its handling of those inputs are checked here. Its
 * real behaviour is exercised by the workflows that use it in the contract and frontend repositories.
 */
const action = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

/** The names under the top-level `inputs:` key. */
function inputNames(): string[] {
  const block = /^inputs:\n([\s\S]*?)^runs:/m.exec(action)?.[1] ?? '';
  return [...block.matchAll(/^ {2}([a-z][a-z-]*):/gm)].map((match) => match[1] ?? '');
}

describe('action.yml', () => {
  it('is a composite action with a name and a description', () => {
    expect(action).toMatch(/^name: .+/m);
    expect(action).toMatch(/^description: /m);
    expect(action).toMatch(/^runs:\n {2}using: composite/m);
  });

  it('declares exactly the inputs the command line has options for, all optional', () => {
    expect(inputNames()).toEqual(['config', 'network', 'min-ttl-days']);
    expect((action.match(/required: false/g) ?? []).length).toBe(3);
    expect(action).toMatch(/default: wasmward\.json/);
  });

  it('never puts an input into script text: inputs reach the shell only through environment variables', () => {
    const uses = [...action.matchAll(/\$\{\{\s*inputs\.[a-z-]+\s*\}\}/g)];
    expect(uses.length).toBeGreaterThan(0);
    const viaEnvironment = [...action.matchAll(/^ {8}WASMWARD_[A-Z_]+: \$\{\{ inputs\.[a-z-]+ \}\}$/gm)];
    // Every use is an `env:` entry (inputs.* in a `with:` or `run:` line would not match this shape).
    expect(viaEnvironment.length).toBe(uses.length);
  });

  it('quotes every variable it expands in a command', () => {
    const run = /name: Check the contracts[\s\S]*$/.exec(action)?.[0] ?? '';
    const unquoted = [...run.matchAll(/(?<!["\w])\$WASMWARD_[A-Z_]+(?!["\w])/g)].map((match) => match[0]);
    expect(unquoted).toEqual([]);
  });

  it('passes the exit code of the check through, and writes a job summary', () => {
    expect(action).toContain('exit "$code"');
    expect(action).toContain('${PIPESTATUS[0]}');
    expect(action).toContain('GITHUB_STEP_SUMMARY');
  });

  it('runs the command line that this repository builds', () => {
    expect(action).toContain('dist/cli.js');
    expect(action).toContain('pnpm build');
    expect(action).toContain('working-directory: ${{ github.action_path }}');
  });

  it('uses only flags the CLI accepts', async () => {
    let usage = '';
    await main(['--help'], { stdout: (text) => (usage += text), stderr: () => undefined });
    for (const flag of ['--config', '--network', '--min-ttl-days']) {
      expect(action).toContain(flag);
      expect(usage).toContain(flag);
    }
  });

  it('is documented in the README with its inputs', () => {
    expect(readme).toContain('contract-version/Wasmward-backend@');
    for (const name of inputNames()) expect(readme).toContain(name);
  });
});
