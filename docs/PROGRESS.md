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

## Phase 1: Config and hashing

**Date:** 2026-10-07

**Built**
- `src/types.ts`: `WasmwardConfig`, `ContractConfig`, `SupportedVersion`, `NetworkConfig`.
- `src/errors.ts`: `ConfigError` with an `issues` list of `{ path, message }`; the message lists every issue with its JSON path.
- `src/config.ts`: zod schema and `loadConfig(object)`. It enforces every rule in the spec and applies the defaults (poll interval 30000 with a 5000 minimum, staleness defaulting to 4 times the poll interval and at least 2 times it). Hashes are lowercased.
- `src/node.ts`: `loadConfigFile(path)`, exported as `@wasmward/core/node`.
- `src/hash.ts`: `hashWasm(bytes)` using Web Crypto.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:coverage`: 70 tests pass, 98.6% lines (gate is 90%)

**Exit criteria**
- Tests for each schema rule, defaults, normalization and error messages: done (`test/unit/config.test.ts`, `test/unit/config-file.test.ts`).
- Hash test: SHA-256 is checked against four known vectors (empty input, "abc", a bare Wasm header, 1 MiB of zeros), computed independently with Node's `crypto`. **Pending:** the comparison of the fixture v1 Wasm hash with the hash printed by the Stellar CLI on upload moves to Phase 7, as the spec allows.

**Open issues**
- `src/cli.ts` is still a placeholder and shows 0% in the coverage report; Phase 6 replaces it.
