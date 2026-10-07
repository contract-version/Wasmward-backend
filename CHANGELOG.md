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
- An upgradeable test contract and a testnet deploy script (in the `Wasmward-contract` repository), and an integration test that runs the guard through a real upgrade.
