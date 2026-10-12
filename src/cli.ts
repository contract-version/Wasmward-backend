import { main } from './cli-core.js';

// The build replaces this with the version in package.json. Run from source, it is not defined.
declare const __WASMWARD_VERSION__: string | undefined;

// Ctrl+C and SIGTERM end `wasmward watch` cleanly instead of killing the process mid-check.
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

void main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: stop.signal,
  version: typeof __WASMWARD_VERSION__ === 'string' ? __WASMWARD_VERSION__ : undefined,
}).then((exitCode) => {
  process.exitCode = exitCode;
});
