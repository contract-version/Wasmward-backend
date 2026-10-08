import { main } from './cli-core.js';

// Ctrl+C and SIGTERM end `wasmward watch` cleanly instead of killing the process mid-check.
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

void main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: stop.signal,
}).then((exitCode) => {
  process.exitCode = exitCode;
});
