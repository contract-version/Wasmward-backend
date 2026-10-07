import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
