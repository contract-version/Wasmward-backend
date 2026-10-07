# Progress

## Phase 0: Bootstrap and duplicate check

**Date:** 2026-10-07

**Built**
- Duplicate check recorded in `docs/DECISIONS.md` (D-002). No existing package covers the scope.
- Package scaffold: `package.json` (scripts, `bin`, `exports` including the `./node` path), strict `tsconfig.json`, ESLint, Vitest, tsup.
- Build produces ESM, CJS and `.d.ts` for the library and an ESM CLI with a Node shebang.
- CI (`.github/workflows/ci.yml`): Node 20 and 22 run lint, typecheck, build and unit tests with coverage. Integration tests run only on manual dispatch or on main.
- All SDK APIs listed in spec section 3 confirmed against the installed types and a runtime probe (D-006).

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm build`: pass (ESM, CJS, DTS, CLI with shebang)
- `pnpm test`: no test files yet, exits 0 (`--passWithNoTests`)

**Open issues**
- CI has not run yet; it runs on the first push to GitHub.
- The `@wasmward` npm scope is not yet claimed (D-001).
- Network to the npm registry is slow on this machine, so installs take minutes.
