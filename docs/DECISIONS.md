# Decisions

Every deviation from the specification, and every choice the specification left open, is recorded here.

## D-001: Project name is Wasmward

- **Date:** 2026-10-07
- **Decision:** The project is named Wasmward, replacing the spec's placeholder name "Contract Version Guard" and the package scope `@versionguard`.
- **Why:** `versionguard` and `version-guard` are already used on npm by unrelated SemVer-enforcement packages, and the name suggests SemVer rather than code identity. Wasmward says what is watched (Wasm) and what it does (stands guard).
- **Mapping:**
  - Package: `@wasmward/core` (library and CLI).
  - CLI binary: `wasmward`.
  - Config file: `wasmward.json`.
- **Open item:** On 2026-10-07 `wasmward`, `wasm-ward` and `@wasmward/core` returned 404 on the npm registry. That proves the package names are unused. It does not reserve the `@wasmward` scope. The scope must be claimed by creating an npm organization before the first publish.

## D-002: Duplicate check (spec Phase 0, step 1)

- **Date:** 2026-10-07
- **Result:** No existing package covers spec section 2.3. Decision: build.
- **npm queries:** `soroban wasm hash`, `soroban version guard`, `soroban upgrade`, `stellar contract upgrade guard`, `soroban contract hash`, `versionguard`.
  - Nothing gates writes on Soroban Wasm hashes.
  - `soroban-guard` exists, but it is SEP-41 token conformance testing.
  - `soroban-events` and `sac-sdk` are unrelated.
  - Several `versionguard` packages exist; all are SemVer or CalVer tooling.
- **GitHub:** The only related repository is `ShippedLabs/soroban-upgrade-safeguard`. It compares Wasm builds before deployment and has no runtime component. The GitHub searches `soroban wasm hash` and `stellar contract version guard` returned no repositories.
- **Limit of the check:** GitHub code search is weak. A manual pass on GitHub and the Stellar community channels is still advisable before announcing.

## D-003: Wasm hash is the only supported-version source

- **Date:** 2026-10-07
- **Decision:** Supported versions are exact Wasm hashes listed in `wasmward.json`. Wasmward does not read the `soroban-upgrade-safeguard` interface lockfile (spec section 2.4).
- **Why:** The lockfile pins an interface hash, not code. The on-chain instance entry exposes only the Wasm hash, so using the lockfile would require downloading the live Wasm and recomputing an interface hash on every check. That is heavy in a browser and makes the fail-closed rule harder to prove.
- **Possible later work:** An optional importer that fills a hash list from a lockfile and Wasm file. Not part of the core.

## D-004: Repository layout across three repositories

- **Date:** 2026-10-07
- **Decision:** The spec describes one repository. The project owner created three, so the work maps as follows:
  - `Wasmward-backend`: the TypeScript SDK and CLI (`@wasmward/core`), everything under spec section 4 except `fixtures/`.
  - `Wasmward-contract`: the Rust upgradeable fixture contract (v1 and v2) and the deploy and upgrade scripts (spec `fixtures/contract` and `fixtures/scripts`).
  - `Wasmward-frontend`: not used in the MVP. The spec forbids UI screens and a React package (sections 1.1 and 2.4). The browser example is a seed-backlog item.
- **Consequence:** The testnet integration test lives in `Wasmward-backend` and reads `fixtures/testnet.json`. That file is produced by the `Wasmward-contract` deploy script and is git-ignored.

## D-005: TypeScript is pinned to 6.0.3, not 7.x

- **Date:** 2026-10-07
- **Decision:** `typescript` is pinned to `6.0.3`. The newest release at resolution time was `7.0.2`.
- **Why:** With 7.0.2, `typescript-eslint` refuses to run ("does not support TS 7.0") and tsup's declaration build cannot load the TypeScript JS API. Phase 0 requires lint and build to pass.
- **Follow-up:** Revisit when `typescript-eslint` and `tsup` support TypeScript 7.
- **Related:** tsup injects the deprecated `baseUrl` option into its declaration build, which TypeScript 6 rejects. `tsup.config.ts` sets `ignoreDeprecations: "6.0"` for the declaration build only.

## D-006: Stellar SDK 17 API mapping (spec section 3)

- **Date:** 2026-10-07
- **Pinned:** `@stellar/stellar-sdk` 17.2.1. Each item below was checked against the installed type definitions and a runtime probe.
- **Confirmed as specified:**
  - `rpc.Server#getLedgerEntries`, `#getNetwork` (returns `{ passphrase, protocolVersion, friendbotUrl? }`), `#getLatestLedger` (returns `{ sequence, ... }`).
  - `xdr.LedgerKey.contractData`, `xdr.LedgerKeyContractData` (constructor takes `{ contract, key, durability }`).
  - `xdr.ScVal.scvLedgerKeyContractInstance()`, `Address#toScAddress()`, `StrKey.isValidContract()`.
- **Differs from the spec text:**
  1. `getLedgerEntries` takes variadic keys: `getLedgerEntries(...keys)`. Batching spreads each chunk.
  2. `xdr.ContractDataDurability.persistent` is a static property, not a method call.
  3. Decoding uses properties and a `type` discriminant, not method chains. The spec's `entry.val.contractData().val().instance().executable()` becomes `entry.val.contractData.val.instance.executable`, after checking `entry.val.type === 'contractData'`, `.val.type === 'scvContractInstance'`, and then the executable's `type`.
  4. Wasm hash bytes come from `executable.wasmHash.toBytes()` and are hex-encoded locally.
  5. Entry keys are matched with `XdrValue#equals`, or by comparing base64 key XDR.
- **New variant:** `ContractExecutable` has three variants in v17: `contractExecutableWasm`, `contractExecutableStellarAsset` and `contractExecutableExternalRef`. The spec's `LiveExecutable` has no case for the third. Decision: map `contractExecutableExternalRef` to `{ kind: 'error' }` with a clear message, so the contract can never be reported `supported`. This follows the fail-closed rule.

## D-007: Config schema choices the spec left open

- **Date:** 2026-10-07
- **Unknown keys are rejected.** Every object in the config is strict. A typo such as `pollIntervalMS` would otherwise be ignored silently and the default used, which is the wrong failure mode for a guard.
- **`label` is optional.** The spec requires labels to be non-empty strings of at most 64 characters when present, and `ContractState.matchedLabel` is optional, so a version may have only a hash.
- **Integer intervals.** `pollIntervalMs` and `maxStalenessMs` must be integers.
- **Browser-safe split.** `loadConfig` is exported from the main entry. `loadConfigFile` lives in `src/node.ts`, published as `@wasmward/core/node`, so browser bundles never import `fs`. `src/node.ts` is not in the spec's file list; it is the file behind the export path the spec requires.
- **Byte order mark.** `loadConfigFile` strips a leading UTF-8 byte order mark before parsing, because Windows editors and PowerShell commonly write one and `JSON.parse` rejects it.
- **Dependent rules wait for independent ones.** zod skips a cross-field rule (duplicate hashes, `maxStalenessMs` against `pollIntervalMs`) while the fields it compares are themselves invalid. A user with several mistakes may therefore see them over two runs. Each run still lists every issue it can evaluate.
- **Contract-name errors.** zod 4 reports a bad record key as a generic "Invalid key in record". `loadConfig` rewrites that issue to `contract name must match <regex>`.

## D-008: Live executable lookup choices

- **Date:** 2026-10-07
- **Key limit:** The Stellar RPC docs state a maximum of 200 keys per `getLedgerEntries` request. `MAX_KEYS_PER_REQUEST` is 200. Larger sets are split into chunks that run in parallel. A failing chunk marks only its own contracts as `error`.
- **Narrow server type:** `fetchExecutables` takes `LedgerEntriesSource` (just `getLedgerEntries(...keys)`) instead of the whole `rpc.Server`. `rpc.Server` satisfies it, and tests can pass a stub.
- **Absent keys mean missing.** The docs do not say what happens for keys that do not exist. Entries for them are not returned, and Wasmward reports `missing`.
- **Archived instances may look missing.** The spec marks an instance `archived` when `liveUntilLedgerSeq < latestLedger`. A live-state RPC may omit expired entries entirely, in which case the contract is reported `missing`. Both statuses block writes, so the outcome is safe either way. Only the label differs.
- **No TTL, no trust.** A Wasm instance returned without `liveUntilLedgerSeq` is reported as `error`, because archival cannot be ruled out. A Stellar Asset Contract without a TTL is still `stellar-asset`, since that status never allows writes anyway.
- **Invalid contract IDs.** An ID that cannot be turned into a key yields `error` for that contract only. The rest of the batch is still looked up.
- **Duplicates.** A contract ID passed twice is requested once. If the RPC returns the same key twice, the first entry wins. Entries for keys that were not requested are ignored.
- **Error text.** The RPC client rejects with plain `{ code, message }` objects for JSON-RPC errors. `messageOf` reads the `message` field so errors are readable rather than `[object Object]`. A replay test found this.
- **Replay tests.** Wire-format responses are generated with the SDK's own XDR builders and served over local HTTP, so the real `rpc.Server` parsing is exercised. Responses recorded from testnet are added in Phase 7.

## D-009: Status model choices

- **Date:** 2026-10-07
- **One function decides writability.** `effectiveStatus(state, now, maxStalenessMs)` returns the status as it stands at call time: a stored `supported` becomes `stale` once the last successful lookup is older than `maxStalenessMs`, with no poller involved. `isWritable` is defined as `effectiveStatus(...) === 'supported'`, so `supported` is the only status that can ever be writable and the call-time staleness check cannot be bypassed.
- **Boundary.** Age equal to `maxStalenessMs` is still fresh ("within" the limit); one millisecond more is stale. This matches the spec's "older than".
- **Clock moving backwards fails closed.** If `now` is earlier than `lastSuccessAt`, or `now` is not a number, freshness cannot be shown, so the contract is reported `stale` and writes are blocked. The next successful poll sets a new `lastSuccessAt` and recovers. A step backwards is rare; being briefly blocked is the safe side of that trade.
- **A `supported` state with no recorded success reads as `pending`.** It cannot arise through `nextState`, but the function does not trust it.
- **Errors after a success follow the spec literally.** Once the last success is older than the limit, the status becomes `stale` whatever it was, including `unsupported` or `missing`. The last seen hash is kept for diagnosis. All of these block writes.
- **`initialState`.** The spec names `ContractState` but not how one starts. `initialState(name, contract)` creates the `pending` state with no history.
- **Results that clear fields.** A successful non-Wasm result (`stellar-asset`, `missing`, `archived`) clears `liveWasmHash` and `matchedLabel`, since no Wasm hash was observed. An unsupported hash keeps `liveWasmHash` and clears `matchedLabel`.

## D-010: Poller choices

- **Date:** 2026-10-07
- **The optional `getLatestLedger` shortcut is not implemented.** The spec allows skipping the entries call when the ledger sequence is unchanged, but only "if tests show it is correct for staleness". It is not: an RPC node that is stuck on one ledger would keep returning the same sequence, the shortcut would keep refreshing `lastSuccessAt`, and a contract would stay `supported` while the guard learns nothing. Every tick therefore does the full lookup.
- **Scheduling is a `setTimeout` chain that arms the next timer after the current tick finishes.** Two ticks cannot overlap, and a tick that outlasts the interval simply delays the next one (the lookup itself is bounded by its timeout). A stop followed by a start while an old tick is still running waits for that tick, so concurrency stays at one. This replaces the spec's "skip that fire" wording with a structure that makes the skip unnecessary.
- **The poller only schedules.** It takes a `tick()` function that returns true when every contract's lookup failed. The guard (Phase 5) supplies the tick that fetches, applies `nextState` and fires change callbacks. A tick that rejects counts as a failing tick.
- **Backoff and jitter.** The wait is `intervalMs` doubled per consecutive failing tick, capped at `maxStalenessMs / 2`, with 0 to 10 percent jitter added on top of the capped value. The real wait can therefore reach 1.1 times the cap. Writes are blocked by the call-time staleness check regardless of when the next tick runs, so this timing only affects how soon state and subscribers update.
- **Restart.** `start()` after `stop()` begins a fresh schedule with the failure count reset. A second `start()` while running returns the same promise and does nothing.

## D-011: Guard and health choices

- **Date:** 2026-10-07
- **The config is validated again** inside `createVersionGuard`. `loadConfig` is idempotent on its own output, so a hand-built or edited object cannot bypass the schema rules.
- **Narrow server type.** `createVersionGuard` takes a `GuardServer` (`getNetwork` and `getLedgerEntries`) rather than the whole `rpc.Server`, so tests can pass a fake chain. `rpc.Server` satisfies it. With no server given, the guard builds one and allows plain http only when the config URL is http, which the config schema already limits to localhost.
- **Start and the network check.** A passphrase mismatch throws `ConfigError` and starts nothing (spec). If the network cannot be reached at all, the spec is silent; `start()` rejects with an `Error` (the original is its `cause`) and starts nothing, because contracts cannot be called `supported` on an unverified network. A failed start can simply be retried. `start()` is idempotent while in flight, `stop()` cancels a start that is still verifying the network, and a restart does not repeat a verification that succeeded.
- **Nothing is writable before the network is verified.** `isWritable`, `assertWritable` and `assertWritableFresh` all require a completed `start()`.
- **Lookup timeout.** The spec gives none. A lookup waits `min(pollIntervalMs, 10s)`, so a hung request can never outlast the polling interval.
- **Freshness is dated from when the lookup began**, not when it ended, so a slow response never looks fresher than it is. Errors are judged against the current time so staleness is noticed as soon as it is real.
- **An older lookup cannot overwrite a newer one.** If a slow poll finishes after a fresh check has already seen an upgrade, the late result is dropped. Otherwise a stale `supported` could replace the correct `unsupported` until the next poll. This is tested.
- **`assertWritableFresh` fails closed.** The spec says it "runs one immediate lookup, then asserts". If that lookup errors, the stored state may still be fresh and supported; asserting on it would defeat the purpose, so the call throws `WriteBlockedError` with the lookup error in the reason.
- **Subscribers see transitions of the effective status.** Each contract remembers the last status it announced, so a change is reported once. Becoming `stale` through time alone, with no check completing, is not pushed; `status()`, `isWritable()` and `health()` still report it.
- **Listener errors are swallowed silently**, as the spec requires ("caught and do not stop the poller"). There is no error hook; adding one would be an option the spec does not list.
- **`status()` applies staleness to the status** and returns copies, so a stopped poller shows `stale` and callers cannot mutate guard state.
- **Health output.** `HealthReport` adds `network.verified`, and `ok` requires it. The RPC URL is omitted because providers often embed API keys in it and health endpoints are commonly exposed. Report fields with no value are left out rather than set to `undefined`, so the output is plain JSON.
- **Wrapper details.** `guard.guard` always returns a promise, so a block surfaces as a rejection. Unknown names throw `ConfigError` when the wrapper is created. It uses local functions rather than `this`, so it works when detached from the guard object.
- **Contract lookup uses a `Map`** so names such as `constructor` are never matched through object inheritance. Tests cover `constructor`, `toString` and `__proto__`.
- **`WriteBlockedError` message** prints the full 64-character hash, not a shortened one, so it can be pasted into the config.

## D-012: CLI choices

- **Date:** 2026-10-07
- **Two files instead of one.** The spec lists `src/cli.ts`. The logic lives in `src/cli-core.ts` as `main(argv, io)`, which returns an exit code and never calls `process.exit`. `src/cli.ts` is a four-line entry that wires it to the real stdout, stderr and exit code. This lets almost all of the CLI be tested in-process and measured by coverage, while `test/cli` still runs the built `dist/cli.js` as a separate process, as the spec's test matrix asks.
- **The Stellar SDK loads lazily.** Importing it takes several seconds on a slow disk (4 to 5 seconds here, inside a OneDrive folder). `wasmward hash` does not need it, so `config`, `node`, `fetch` and the SDK client are imported dynamically by `add` and `check` only. `hash` now starts in about 0.5 seconds. The build therefore emits a few shared chunk files next to `dist/cli.js`; `files: ["dist"]` ships them.
- **`add` needs `--label`.** The spec's command table shows `--label` unbracketed and `--config` bracketed, so the label is required even though the config schema allows a version without one.
- **`add` only extends existing contracts.** It has no way to learn a contract ID, so an unknown contract name is an error (exit 2) that lists the configured names.
- **`add` edits the file's own JSON, not the loaded config.** The loaded config has defaults filled in and hashes lowercased; writing that back would rewrite the user's file. Instead the raw document is validated, the new entry is appended, the result is validated again, and only then is it written. The output is JSON with two-space indentation and a trailing newline, keeping the file's original key order.
- **Duplicates are compared in lowercase**, so an uppercase hash already in the file counts. A duplicate is exit 2 ("invalid input") and the file is not touched.
- **Atomic write.** The new content goes to a uniquely named temporary file in the same folder, then `rename` replaces the target. If anything fails, the temporary file is removed and the original is untouched. Tests prove the target still holds the old content at the moment of the rename.
- **`check` exit codes.** The spec gives 0 (all supported), 1 (any not supported) and 2 (config or network error). A lookup that errors for a contract means its live code could not be determined at all, so that is reported as 2, not 1, and takes precedence over 1 when both occur. Every contract's status is still printed.
- **`check` verifies the network first.** It calls `getNetwork` and compares the passphrase before looking anything up; a mismatch or an unreachable RPC is exit 2. Both calls use a timeout of the smaller of the poll interval and 10 seconds.
- **`--json` everywhere.** Success output is JSON. For `check` it is the same shape as `guard.health()` plus `exitCode`. With `--json`, errors are printed as `{ "ok": false, "error", "exitCode" }` on stdout instead of text on stderr, so a pipeline gets parseable output on every path.
- **`--help` / `-h`** prints usage on stdout and exits 0. This is not in the spec; it costs a few lines and a command-line tool without it is hard to use. With no command, usage goes to stderr and the exit code is 2.

## D-013: Fixture and testnet integration choices

- **Date:** 2026-10-07
- **The fixture lives in `Wasmward-contract`** (D-004). Its `scripts/deploy.sh` writes `testnet.json` and `build/`, both git-ignored. The integration test in this repository reads them from `../Wasmward-contract`, or from `WASMWARD_FIXTURE_DIR`.
- **Constructor.** The fixture uses `__constructor(admin)`, which the pinned `soroban-sdk` 26.1.1 supports, rather than a separate `init()`.
- **`soroban-sdk` is 26.1.1, not the newest (28.0.0).** It is the version the Stellar CLI 27 `contract init` template pins. Testnet reports protocol 29, and contracts built with an older SDK keep running on a newer protocol; the deploy and upgrade on testnet confirm it.
- **Secrets.** `deploy.sh` uses `FIXTURE_SECRET` when it is set in the environment or in `.env`. Otherwise it generates a fresh identity in a temporary directory and appends only the secret to `.env`; nothing is printed. The Stellar CLI's own copy of the identity lives in `.stellar-keys/` (not `.stellar/`, which the CLI treats as a legacy config folder and warns about). `testnet.json` contains public values only. `.env`, `.stellar-keys/`, `testnet.json` and `build/` are git-ignored.
- **Hash check in two places.** `deploy.sh` fails if a locally computed SHA-256 differs from the hash Stellar returns on upload. The integration test then recomputes both hashes with `hashWasm` and compares them with `testnet.json`, so the library's own hash function is tested against the chain.
- **The upgrade is signed with the SDK, not the CLI.** The test builds, simulates, signs and sends the `upgrade` transaction itself from `FIXTURE_SECRET`, so it needs no Stellar CLI on the machine that runs it.
- **Re-runnable.** The test restores the contract to v1 before it starts, if an earlier run left it on v2, and again when it finishes, so one deployed fixture can be tested repeatedly.
- **Detection time is measured on the local clock.** The test starts counting when the upgrade is confirmed. An earlier version compared the ledger close time with the local clock and reported 23 seconds for a test that ran in 6; the local clock here runs well ahead of ledger time, so that number was an artifact, and the approach was dropped.
- **Skipped, not failed, without a fixture.** With no `testnet.json` or secret, the integration tests skip and print why. They never pass by default: the CI job deploys the fixture first.
- **CI.** The `integration` job checks out `Wasmward-contract`, installs the Stellar CLI release binary, runs `deploy.sh`, then the tests. It always runs on manual dispatch and on pushes to main only when a `FIXTURE_SECRET` repository secret exists (without it, `deploy.sh` would ask friendbot to fund a new account on every push). The Linux CLI download path has not yet been run on a hosted runner.
- **Recorded responses.** `test/fixtures/recorded/testnet-v1.json` holds the real `getLedgerEntries` and `getNetwork` replies for the deployed fixture. `test/replay/recorded.test.ts` serves them over HTTP to the real `rpc.Server`.

## D-014: Release preparation choices

- **Date:** 2026-10-07
- **Version 0.1.0 is prepared, not published, not tagged.** `package.json` is at 0.1.0 with repository, bugs, homepage, keywords and `publishConfig` (public, with provenance). Publishing needs two things that only the project owner can provide: the `@wasmward` scope claimed on npm (D-001) and an `NPM_TOKEN` repository secret. `.github/workflows/release.yml` publishes with provenance when a `v*` tag is pushed, after lint, typecheck, build and the coverage gate, and it refuses a tag that does not match the package version. Nothing publishes until a tag is pushed.
- **The changelog entry is dated "Unreleased".** The date is set when the version is tagged.
- **README example.** It targets the Wasmward test contract on testnet, so it runs as written with no setup. If that contract expires, the example prints why writes are blocked rather than failing. `test/integration/readme.test.ts` extracts the first `js` block from the README and runs it, so the example cannot drift from the code.
- **Browser bundle check.** `test/unit/browser-bundle.test.ts` builds the main entry with tsup for `platform: browser` with every dependency inlined, then lists the Node built-ins the output still imports; the list must be empty. The bundler keeps built-ins as external imports instead of failing, which is why the output is inspected. Two controls prove the check can fail: the Node-only entry does import `fs/promises`, and the helper recognises each import spelling.
- **Package contents.** `files: ["dist"]` plus npm's automatic README, LICENSE and package.json. A test runs `npm pack --dry-run` and fails on any other file. The CLI's lazy chunks and source maps are inside `dist`.
- **`npx` from the tarball.** The CI test job packs the package and runs `npx --package ./wasmward-core-*.tgz wasmward hash README.md` and `--help` on Node 20 and 22. Locally the same tarball was extracted and run with the installed dependencies linked, including a command that loads the lazy chunks; a real `npx` install was not run locally because the npm registry is too slow on this machine.
- **Security policy.** It names GitHub Security Advisories as the private channel and lists which reports matter most, but gives no response-time promise; that is a commitment for the maintainers to make.
- **The seed backlog is not opened.** The spec lists five issues to open after the MVP. Opening them publishes content on a public repository, so it waits for the project owner's go-ahead.
