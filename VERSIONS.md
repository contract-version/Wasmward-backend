# Pinned versions

Resolved on 2026-10-07. Exact versions only; see `pnpm-lock.yaml` for the full tree.

| Package | Version | Role |
|---|---|---|
| `zod` | 4.6.5 | runtime dependency |
| `@stellar/stellar-sdk` | 17.2.1 | peer dependency (`>=17.2.1 <18`) and dev dependency |
| `typescript` | 6.0.3 | dev (see D-005 for why not 7.x) |
| `tsup` | 8.5.1 | dev |
| `vitest` | 5.0.3 | dev |
| `@vitest/coverage-v8` | 5.0.3 | dev |
| `eslint` | 10.12.0 | dev |
| `@eslint/js` | 10.0.1 | dev |
| `typescript-eslint` | 8.71.1 | dev |
| `@types/node` | 26.6.4 | dev |

Toolchain used locally: Node 24.8.0, pnpm 10.30.1. CI runs Node 20 and 22.
