# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release. Set the date when the version is tagged.

### Added

- `loadConfig` and `loadConfigFile` (from `@wasmward/core/node`): a validated `wasmward.json` format listing each contract and the Wasm hashes the app supports, with clear errors that give the JSON path of every problem.
- `hashWasm`: the SHA-256 of Wasm bytes using Web Crypto, equal to the hash Stellar assigns on upload.
- `fetchExecutables`: looks up the live executable of contract instances from Stellar RPC in batched requests, and reports `wasm`, `stellar-asset`, `missing`, `archived` or `error`.
- A status model in which only `supported` allows writes, with a staleness check made at call time so a stopped poller cannot leave a stale `supported` in place.
- A poller with an interval, jitter, exponential backoff, no overlapping checks, and a clean stop.
- `createVersionGuard`: `start`, `stop`, `status`, `isWritable`, `assertWritable`, `assertWritableFresh`, `guard` (a function wrapper), `subscribe` (change callbacks) and `health` (framework-neutral JSON). It verifies the network passphrase before it starts.
- `WriteBlockedError` and `ConfigError`.
- The `wasmward` command line tool with `hash`, `add` and `check`. `check` exits 0 when every contract is supported, 1 when any is not, and 2 on a configuration or network error. Config writes are atomic.
- `wasmward init`: creates a config for one contract, starting from a Wasm file (`--wasm`) or, with a clear warning about the trust involved, from the code that is live on the network. Never overwrites an existing file.
- `wasmward watch`: keeps checking and prints each status change, as text or JSON lines, until interrupted with Ctrl+C or SIGTERM.
- Several networks in one config file: a `networks` section whose entries have the single-network shape. Choosing a network is always explicit (`loadConfig(file, { network })`, `--network <name>`), and `wasmward check` without `--network` checks every network. Adds `loadConfigDocument`, `loadConfigDocumentFile` and the `ConfigDocument` type.
- `subscribe` now announces `supported -> stale` the moment it happens, using a timer, instead of at the next poll. `pollIntervalMs` is limited to one day, and no poll or staleness delay can exceed what a timer can wait.
- `wasmward check --min-ttl-days <n>`: an opt-in gate that fails (exit 1) when a supported contract has fewer than n days left; the JSON marks the contracts and the minimum.
- `wasmward check` shows how long each contract instance has left (and suggests extending when under about a week); the state and health report carry `liveUntilLedger`, `latestLedger` and `ledgersUntilExpiry`. Informational only.
- `docs/THREAT-MODEL.md`: the guarantee, what it defends against, what it trusts, and what it cannot do.
- The published package is tested as installed: loaded with `import` and `require`, and type-checked from TypeScript for both module systems.
- RPC requests are really cancelled after their timeout (`createRpcClient`), so an RPC that never answers cannot leave connections open or make `wasmward check` hang.
- Optional `network.fallbackRpcUrls`: when the primary RPC cannot answer, the guard and `wasmward check` fall back to the next endpoint. Each endpoint must report the configured network passphrase before it is used, and `health().network.usingFallback` shows when a spare is in use. Also exports `createEndpointSet` and the `WasmwardConfigInput` type.
- A browser example in the `Wasmward-frontend` repository: a page that watches the test contract and disables a write button through `guard.subscribe`.
- `docs/PAIRING.md`: how to use Wasmward together with soroban-upgrade-safeguard in a release workflow, with a GitHub Actions example.
- An upgradeable test contract and a testnet deploy script (in the `Wasmward-contract` repository), and an integration test that runs the guard through a real upgrade.
