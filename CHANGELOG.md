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
- `wasmward watch`: keeps checking and prints each status change, as text or JSON lines, until interrupted with Ctrl+C or SIGTERM.
- Several networks in one config file: a `networks` section whose entries have the single-network shape. Choosing a network is always explicit (`loadConfig(file, { network })`, `--network <name>`), and `wasmward check` without `--network` checks every network. Adds `loadConfigDocument`, `loadConfigDocumentFile` and the `ConfigDocument` type.
- Optional `network.fallbackRpcUrls`: when the primary RPC cannot answer, the guard and `wasmward check` fall back to the next endpoint. Each endpoint must report the configured network passphrase before it is used, and `health().network.usingFallback` shows when a spare is in use. Also exports `createEndpointSet` and the `WasmwardConfigInput` type.
- A browser example in the `Wasmward-frontend` repository: a page that watches the test contract and disables a write button through `guard.subscribe`.
- `docs/PAIRING.md`: how to use Wasmward together with soroban-upgrade-safeguard in a release workflow, with a GitHub Actions example.
- An upgradeable test contract and a testnet deploy script (in the `Wasmward-contract` repository), and an integration test that runs the guard through a real upgrade.
