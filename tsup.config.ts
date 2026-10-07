import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    // tsup injects `baseUrl`, which TypeScript 6 flags as deprecated.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['@stellar/stellar-sdk', 'zod'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    external: ['@stellar/stellar-sdk', 'zod'],
  },
]);
