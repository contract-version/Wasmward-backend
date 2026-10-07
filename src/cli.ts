import { main } from './cli-core.js';

void main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then((exitCode) => {
  process.exitCode = exitCode;
});
