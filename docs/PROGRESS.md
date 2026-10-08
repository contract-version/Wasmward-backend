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
- Hash test: SHA-256 is checked against four known vectors (empty input, "abc", a bare Wasm header, 1 MiB of zeros), computed independently with Node's `crypto`. **Done in Phase 7:** the fixture v1 and v2 Wasm hashes computed by `hashWasm` equal the hashes Stellar returned on upload (see Phase 7).

**Open issues**
- `src/cli.ts` is still a placeholder and shows 0% in the coverage report; Phase 6 replaces it.

## Phase 2: Live executable lookup

**Date:** 2026-10-07

**Built**
- `src/fetch.ts`: `fetchExecutables(source, contractIds, timeoutMs)` returns a map with an entry for every requested contract: `wasm`, `stellar-asset`, `missing`, `archived` or `error`.
- Builds the persistent `scvLedgerKeyContractInstance` key per contract, batches into one call (chunks of 200), matches entries by key XDR, applies the timeout, and never throws.
- `LiveExecutable` added to `src/types.ts`.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:coverage`: 107 tests pass, 97.9% lines

**Exit criteria**
- Each kind, mixed batch, out-of-order entries, chunking and timeout are covered in `test/unit/fetch.test.ts`.
- The same cases run through the real `rpc.Server` against a local HTTP server in `test/replay/fetch.test.ts`, including HTTP 500, a JSON-RPC error, malformed JSON, a hung server and a closed port.
- Pending: replays of responses recorded from testnet (Phase 7).

**Open issues**
- The two uncovered lines in `fetch.ts` are the exhaustiveness guard for a future SDK executable variant; the compiler makes it unreachable.

## Phase 3: Status model

**Date:** 2026-10-07

**Built**
- `src/state.ts`: pure functions with no I/O and no clock: `initialState`, `nextState`, `effectiveStatus`, `isWritable`.
- `Status` and `ContractState` added to `src/types.ts`.
- Writability is derived from `effectiveStatus`, so only `supported` can allow writes, and staleness is re-checked on every call.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:coverage`: 195 tests pass, 98.2% lines

**Exit criteria**
- Table-driven tests in `test/unit/state.test.ts` cover every result kind from every previous status (7 statuses by 6 successful results), error handling before and after a success (within, at and past the limit), recovery, upgrade and config-update transitions, purity with frozen inputs, and the call-time staleness check including a stopped poller and a backwards clock.

**Open issues**
- None.

## Phase 4: Poller

**Date:** 2026-10-07

**Built**
- `src/poller.ts`: `createPoller({ intervalMs, maxStalenessMs, tick, random? })` returning `{ start, stop }`, and the pure `nextDelayMs` used for scheduling.
- Immediate first check on `start()`, `setTimeout` chain, 0 to 10 percent jitter, doubling backoff on all-failed ticks capped at `maxStalenessMs / 2`, reset on success, `unref()` on Node timers, `stop()` that waits for an in-flight tick, and a no-op second `start()`.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:coverage`: 221 tests pass, 98.6% lines (`poller.ts` 100% lines)

**Exit criteria**
- Fake-timer tests in `test/unit/poller.test.ts` cover the schedule, jitter bounds, backoff doubling and the cap, reset after success, a throwing tick, no overlap (including a tick longer than the interval and a stop-then-start race), stop during an in-flight tick, stop during the first tick, double start, restart, `unref`, and numeric timer handles.

**Open issues**
- The `getLatestLedger` optimization was deliberately left out (D-010).

## Phase 5: Public API and health

**Date:** 2026-10-07

**Built**
- `src/guard.ts`: `createVersionGuard` with `start`, `stop`, `status`, `isWritable`, `assertWritable`, `assertWritableFresh`, `subscribe`, `guard` and `health`.
- `src/health.ts`: `buildHealth` and the `HealthReport` type.
- `WriteBlockedError` in `src/errors.ts`; `describeBlock` in `src/state.ts` for the reason text.
- `docs/API.md` documents every export.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:coverage`: 288 tests pass, 99.1% lines

**Exit criteria**
- Network mismatch at start (no polling, nothing writable): tested.
- Subscribe fires once per transition: tested (supported, unsupported, supported again, plus stale).
- Wrapper blocks and passes through return values and errors: tested, including sync functions, detached use and `fresh: true`.
- Fresh assert performs exactly one lookup: tested.
- Health output shape: tested, including a JSON round trip and absence of the RPC URL.
- A stopped poller cannot leave a contract writable past `maxStalenessMs`: tested.
- A race found and fixed while writing the tests: two concurrent `start()` calls each verified the network. `start()` is now idempotent while in flight.

**Open issues**
- `docs/OPERATIONS.md` (health endpoint examples for Express and Next.js) is written in Phase 8.

## Phase 6: CLI

**Date:** 2026-10-07

**Built**
- `src/cli-core.ts`: `main(argv, io)` with `hash`, `add` and `check`, using `util.parseArgs` and no CLI framework. Human-readable output by default and JSON with `--json`.
- `src/cli.ts`: the four-line entry that becomes `dist/cli.js` (Node shebang confirmed in the build).
- Exit codes: `hash` 0 or 2; `add` 0 or 2; `check` 0, 1 or 2.

**Commands run and results**
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm build`: pass
- `pnpm test:coverage`: 346 tests pass, 99.6% lines

**Exit criteria**
- Each command, each exit code, JSON output and atomic write behaviour are covered:
  - `test/unit/cli.test.ts`: in-process, with a fake chain.
  - `test/unit/cli-atomic.test.ts`: a failing rename leaves the original and no temporary file, and the target changes only at the final rename.
  - `test/cli/cli.e2e.test.ts`: runs the built `dist/cli.js` as a separate process against a local JSON-RPC server, including the deploy-gate story (upgrade, `check` exits 1, `add` the new build, `check` exits 0) and the default `./wasmward.json` path.

**Findings**
- Startup took 4 to 5 seconds because every command imported the Stellar SDK. `hash` now avoids it (D-012).

**Open issues**
- The spawned-process tests take several seconds each on this machine because `check` and `add` still load the SDK; they have a 90 second timeout.

## Phase 7: Fixture contract and testnet integration

**Date:** 2026-10-07

**Built**
- `Wasmward-contract`: `contracts/fixture` (`__constructor`, `version`, `upgrade`; the `v2` feature selects the second build), its unit tests for both builds, and `scripts/deploy.sh`.
- `test/integration/upgrade.test.ts` and `fixture.ts` in this repository; `test/replay/recorded.test.ts` with responses recorded from testnet.
- CI integration job that deploys the fixture, then runs the tests.

**Commands run and results**
- `cargo test` and `cargo test --features v2` in `Wasmward-contract`: pass.
- `bash scripts/deploy.sh`: built v1 and v2, uploaded both, compared hashes, deployed v1.
- `pnpm test:integration`: 4 tests pass against Stellar testnet. Run four times in total; each run starts from v1 and leaves the contract on v1.
- `pnpm test:coverage`: 350 tests pass, 99.6% lines.

**Hash equality, local versus on-chain** (recorded as the spec requires)

| Build | SHA-256 computed locally | Hash returned by the upload | Equal |
|---|---|---|---|
| v1 | `a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509` | same | yes |
| v2 | `ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875` | same | yes |

`deploy.sh` checks this with `sha256sum`; the integration test checks it again with `hashWasm`. That settles the Phase 1 item that was waiting for a real Wasm file.

**Fixture on testnet**
- Contract: `CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV`, deployed 2026-10-07. Testnet may reset, and a contract that is not extended eventually expires; re-run `deploy.sh` to make a new one.

**Success criteria from spec section 2.5, observed on testnet**
- With only v1 supported, the guard moved to `unsupported` within one poll interval of the upgrade (5 s interval; noticed about 0.7 to 0.8 s after the upgrade was confirmed) and `assertWritable` threw.
- With the v2 hash added to the config, a new guard returned to `supported`.
- A random valid contract ID was reported `missing` and blocked.

**Open issues**
- Resolved: the CI integration job has run on a hosted Ubuntu runner from a clean checkout (manual dispatch, 2026-10-07; green). It runs on pushes to main only if a `FIXTURE_SECRET` secret exists, and on manual dispatch.

## Phase 8: Documentation and release

**Date:** 2026-10-07

**Built**
- `README.md` (problem statement, install, a usage example that runs as written, CLI, API overview, links, license), `docs/API.md`, `docs/OPERATIONS.md` (recommended settings, upgrade order, deploy-pipeline use of `check`, limits, status guide, Express and Next.js health endpoints, alerts, frontends).
- `CONTRIBUTING.md` (with a Stellar Wave section), `SECURITY.md`, `CHANGELOG.md`, issue templates for bugs and features (each with acceptance criteria and files-touched fields), and a pull request template. `LICENSE` is Apache-2.0.
- Package metadata for 0.1.0 and a tag-triggered release workflow with npm provenance.
- Tests for the browser bundle, the package contents, and the README example.

**QA checklist (spec section 7.2)**

| Item | Result |
|---|---|
| Fresh clone: install, build and unit tests pass | Pass. A clone of the pushed repository: `pnpm install --frozen-lockfile` (48 s), build, lint and typecheck clean, 14 test files and 357 tests pass, 99.58% lines. |
| Integration tests pass on testnet, including the real upgrade | Pass. Run repeatedly; each run restores the contract to v1. |
| `supported` is the only status for which `isWritable` returns true | Pass. A grep of `src` shows `isWritable` is defined once, as `effectiveStatus(...) === 'supported'` (`state.ts`), and the health `writable` flag uses the same comparison (`health.ts`). Tests enumerate all seven statuses. |
| A stopped poller cannot leave a contract writable past `maxStalenessMs` | Pass. Tests in `test/unit/state.test.ts` and `test/unit/guard.test.ts` ("blocks writes once a stopped poller leaves the last success too old"). |
| Network passphrase mismatch prevents start | Pass. `test/unit/guard.test.ts`, and for the CLI `check`. |
| Main entry bundles for a browser without `fs` or `path` | Pass. `test/unit/browser-bundle.test.ts`, with controls. |
| `npm pack` contains only dist, README.md, LICENSE, package.json | Pass. `test/unit/package.test.ts`. |
| CLI works via `npx` from the packed tarball | Locally: the extracted tarball ran (`hash`, `--help`, and `check`, which loads the lazy chunks). Real `npx` is a CI step that runs on the next push. |
| README examples run as written | Pass, against live testnet. `test/integration/readme.test.ts`. |
| PROGRESS covers every phase, DECISIONS lists every deviation | Done (this file and `docs/DECISIONS.md`, D-001 to D-014). |

**Commands run and results**
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: pass.
- `pnpm test:coverage`: all unit, replay, CLI and packaging tests pass; line coverage above the 90% gate.
- `pnpm test:integration`: testnet upgrade flow and the README example pass.

**Open issues**
- Not done, and only the project owner can: claim the `@wasmward` npm scope, add the `NPM_TOKEN` secret, set the date in `CHANGELOG.md`, and push the `v0.1.0` tag, which publishes.
- The five seed-backlog issues have not been opened (D-014).
- Resolved: the CI `npx` step passes on Node 20 and 22, and the CI integration job passes on a hosted runner.

**CI integration run on a hosted runner** (2026-10-07, manual dispatch of the `CI` workflow)
- The `integration` job installed the Stellar CLI 27.0.0 Linux binary, generated a fresh testnet identity, deployed a new fixture and ran the tests on Ubuntu.
- The 4 testnet upgrade tests passed: the guard noticed the upgrade 3.8 s after it was confirmed with a 5 s poll interval. The runner's own hashes (v1 `bfa19d1b6aef2f8fec117943afe55ab52b39cae6ac80d8fa949b2cd91230887c`, v2 `b588049d12b3cae5b412d025986c10fa945c6696ff305392a44b3a3f235a340d`) matched what it uploaded. They differ from the Windows build hashes above because the same source builds to different Wasm on different toolchains; see `docs/OPERATIONS.md`.
- The 2 README tests failed because the job did not run `pnpm build`. The job now builds before testing.

## Extra: `wasmward watch`

**Date:** 2026-10-08

**Built**
- `wasmward watch [--config path] [--json]` in `src/cli-core.ts`, with SIGINT and SIGTERM handled in `src/cli.ts`. A seed-backlog item built on request (D-015).

**Results**
- `test/unit/cli-watch.test.ts`: 12 tests covering transitions, quiet polls, JSON lines, a failing first lookup and its recovery, a missing contract, network mismatch and unreachable RPC, a missing config, an already-aborted signal, extra arguments, a missing signal, and a clean stop with no timers left.
- Run against the live testnet fixture: printed `pending -> supported` with the v1 hash and label, and exited 0 when stopped by SIGTERM.

## Extra: pairing guide

**Date:** 2026-10-08

**Built**
- `docs/PAIRING.md`: a six-step release workflow combining soroban-upgrade-safeguard and Wasmward, a GitHub Actions sketch, and a list of things to know. Linked from the README, `docs/OPERATIONS.md` and the changelog. A seed-backlog item built on request (D-016).

**Results**
- The Wasmward steps (`hash`, `check --json`, `add`, `check`) were run for real against the testnet fixture: candidate hash `ec040ead...`, live hash `a7a82511...`, config updated atomically, `check` exit 0 with both builds supported.
- Writing the guide caught a real bug in its own first draft: reading the live hash through a pipe fails under `bash -e -o pipefail` when `check` exits 1. Fixed and re-tested.
- The upstream safeguard repository did not compile on the default branch (D-016), so its commands are documented from its README and labelled as such.

## Extra: browser example

**Date:** 2026-10-08

**Built** (in `Wasmward-frontend`)
- `index.html`, `src/main.js`, `build.mjs`, `serve.mjs`, a README with run instructions and a walkthrough, and a CI workflow. A seed-backlog item built on request (D-017).

**Results**
- Ran in the built-in browser against live testnet: `pending -> supported` with the v1 hash and label, deposit worked, switching to the older build gave `unsupported`, a disabled button and the exact blocked message, and no console errors.
- Phone-width check found a hash overflowing its container; fixed with `overflow-wrap`.
- Frontend CI (clean checkout of both repositories, install, build, bundle check) passes.

## Extra: fallback RPC endpoints

**Date:** 2026-10-08

**Built**
- `network.fallbackRpcUrls` in the config; `src/endpoints.ts` with `createEndpointSet`; the guard, `wasmward check` and `wasmward watch` fail over to spare endpoints, each verified against the configured network first; `health().network.usingFallback`. A seed-backlog item built on request (D-018).

**Results**
- `pnpm test:coverage`: 429 tests pass (60 new), 99.65% lines; typecheck, lint and build clean.
- Live testnet: `check` with a dead primary and real testnet fallback exits 0 (`usingFallback: true`); both dead exits 2; the integration suite still passes.

## Extra: several networks in one config file

**Date:** 2026-10-08

**Built**
- A `networks` section in the config; `loadConfigDocument`, `loadConfigDocumentFile`, a `network` option on `loadConfig` and `loadConfigFile`; a `--network` option on `check`, `add` and `watch`, with `check` covering every network when none is named. The last seed-backlog item, built on request (D-019).

**Results**
- `pnpm test:coverage`: 499 tests pass (70 new), 99.7% lines; typecheck, lint and build clean.
- Live testnet: a `mainnet` section whose RPC serves testnet was reported as an error (exit 2) while testnet checked normally; `add` without `--network` refused; `add --network testnet` edited only that network.

**Status of the seed backlog:** all five items are done: browser example (D-017), multiple networks (D-019), `watch` (D-015), pairing guide (D-016), fallback RPC endpoints (D-018). No backlog issue has been opened.

## Extra: stale announced on time, and timer limits

**Date:** 2026-10-08

**Built**
- A timer in the guard that announces `supported -> stale` at the moment it happens; poll delays clamped to what a timer can wait; `pollIntervalMs` limited to one day. Closes a documented limitation and a latent tight-loop bug (D-020).

**Results**
- `pnpm test:coverage`: 514 tests pass (15 new), 99.7% lines; typecheck, lint and build clean.
- Live testnet with real clocks: stale announced 10,007 ms after the last good check against a 10,000 ms limit.

## Extra: `wasmward init`

**Date:** 2026-10-08

**Built**
- `wasmward init <name> <contract-id>` with `--preset`, `--rpc-url`, `--passphrase`, `--wasm`, `--label`, `--config`, `--json`. Starts from a Wasm file or, with a warning, from the live code; refuses anything it cannot protect; never overwrites (D-021).

**Results**
- `pnpm test:coverage`: 554 tests pass (40 new), 99.6% lines; typecheck, lint and build clean.
- Live testnet: `init` from the chain and `init --wasm` on the local build gave the identical hash; `check` passed on the result; re-running `init` refused.

## Extra: review round

**Date:** 2026-10-08

**Fixed** (D-022)
- The stale timer re-arming itself in a tight loop after an announcement.
- A retried `start()` succeeding through a fallback when the primary is on the wrong network.
- An uppercase `HTTP://` scheme passing validation and then crashing the RPC client.
- `WasmwardConfigInput` requiring settings that have defaults.

**Results**
- `pnpm test:coverage`: 566 tests pass (12 new regression tests, each shown to fail without its fix), 99.6% lines; typecheck and lint clean.

**Open**
- A hung RPC leaves its socket open, because the SDK's `timeout` option is unused in 17.2.1. Not a correctness problem; to be fixed and tested before 0.1.0 is published (D-022).
- The browser example's build selector is not serialised against rapid changes.
