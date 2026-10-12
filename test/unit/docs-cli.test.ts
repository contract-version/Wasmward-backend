import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli-core.js';

// docs/CLI.md describes what `wasmward --help` prints. These tests keep the two from drifting: a command or an option
// added to the tool without a line in the reference fails here, and so does a reference to one that no longer exists.

const doc = readFileSync(new URL('../../docs/CLI.md', import.meta.url), 'utf8');

async function help(): Promise<string> {
  let out = '';
  await main(['--help'], { stdout: (text) => (out += text), stderr: () => undefined });
  return out;
}

/** The names after "wasmward " at the start of a usage line in the help. */
const commandsIn = (text: string): string[] => [...new Set([...text.matchAll(/^ {2}wasmward ([a-z]+)\b/gm)].map((match) => match[1] as string))];
const optionsIn = (text: string): string[] => [...new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((match) => match[1] as string))];

describe('docs/CLI.md', () => {
  it('has a section for every command the help lists', async () => {
    const commands = commandsIn(await help());
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const command of commands) {
      expect(doc, `no "### ${command}" section`).toMatch(new RegExp(`^### ${command}$`, 'm'));
      expect(doc, `${command} is missing from the table`).toMatch(new RegExp(`^\\| \\[\`${command}\`\\]\\(#${command}\\)`, 'm'));
    }
  });

  it('has no section for a command that does not exist', async () => {
    const commands = new Set(commandsIn(await help()));
    const sections = [...doc.matchAll(/^### ([a-z]+)$/gm)].map((match) => match[1] as string);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) expect(commands.has(section), `"### ${section}" is not a command`).toBe(true);
  });

  it('lists every option the help lists, in the options table', async () => {
    const table = doc.slice(doc.indexOf('## Options'), doc.indexOf('## Exit codes'));
    for (const option of optionsIn(await help())) {
      expect(table, `--${option} is missing from the options table`).toContain(`\`--${option}`);
    }
  });

  it('mentions no option the tool does not have', async () => {
    const real = new Set(optionsIn(await help()));
    for (const option of optionsIn(doc)) expect(real.has(option), `--${option} is in the reference but not in the help`).toBe(true);
  });

  it('describes the three exit codes the help describes', async () => {
    const text = await help();
    for (const code of ['0', '1', '2']) {
      expect(text).toMatch(new RegExp(`^ {2}${code} `, 'm'));
      expect(doc).toMatch(new RegExp(`^\\| \`${code}\` \\|`, 'm'));
    }
  });

  it('is linked from the README', () => {
    expect(readFileSync(new URL('../../README.md', import.meta.url), 'utf8')).toContain('docs/CLI.md');
  });
});
