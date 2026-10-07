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
