import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The first command that loads the Stellar SDK can take seconds on a busy machine; a test that waits for it
    // should not fail for that.
    testTimeout: 30_000,
    include: ['test/unit/**/*.test.ts', 'test/replay/**/*.test.ts', 'test/cli/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts is a four-line entry that is exercised by test/cli, which runs the built file.
      exclude: ['src/index.ts', 'src/types.ts', 'src/cli.ts'],
      thresholds: { lines: 90 },
    },
  },
});
