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
