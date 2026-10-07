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
