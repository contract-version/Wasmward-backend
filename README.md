# Wasmward

A runtime guard for Soroban contract upgrades. A contract can be upgraded in place, so an app that still encodes calls for the old interface may see its writes fail, or worse, succeed with the wrong meaning. Wasmward checks which Wasm code a contract is running on the network, compares its hash with the hashes your app supports, and blocks writes whenever the code is unknown, cannot be verified, or the check is stale. It is small enough to run in a backend or a browser, and it fails closed.

Tools such as [soroban-upgrade-safeguard](https://github.com/ShippedLabs/soroban-upgrade-safeguard) compare builds *before* an upgrade is deployed. Wasmward is the other half: it runs in your app *after* the upgrade, whoever made it. [They work well together](docs/PAIRING.md).

> **Status:** version 0.1.0, not yet published to npm. Until it is, install from a clone of this repository.

## Install

```bash
npm install @wasmward/core @stellar/stellar-sdk
```

`@stellar/stellar-sdk` (17.2.1 or a later 17.x) is a peer dependency. Node.js 20 and 22 are supported, and the library has no Node-only code outside `@wasmward/core/node`.

## Use

This example guards the test contract Wasmward uses in its own tests, on Stellar testnet. It runs as written with Node 20 or later (save it as `example.mjs`):

```js
import { createVersionGuard, loadConfig } from '@wasmward/core';

// The hashes of the Wasm builds this app knows how to talk to.
const config = loadConfig({
  version: 1,
  network: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  contracts: {
    vault: {
      contractId: 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV',
      supported: [
        {
          wasmHash: 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509',
          label: 'v1',
        },
      ],
    },
  },
});

const guard = createVersionGuard(config);

// Called whenever a contract's status changes, including the first check.
guard.subscribe((change) => {
  console.log(`${change.name}: ${change.from} -> ${change.to}`);
});

await guard.start(); // checks the network, looks up the live code, then keeps checking

// Wrap a write so it is refused while the live code is not supported.
const deposit = guard.guard('vault', async (amount) => `would deposit ${amount}`);

try {
  console.log(await deposit(10));
} catch (error) {
  console.log(error.message); // Writes to 'vault' are blocked: ...
}

console.log(guard.health());
await guard.stop();
```

If the test contract has expired, the example prints why writes are blocked instead of failing.

In a browser, use `loadConfig` and `guard.subscribe` directly. A complete, runnable page that does this is in [Wasmward-frontend](https://github.com/contract-version/Wasmward-frontend). `loadConfigFile` lives in `@wasmward/core/node`, so browser bundles never import `fs`.

## Command line

```bash
npx wasmward init vault C... --preset testnet --wasm build/contract.wasm   # create wasmward.json
npx wasmward hash build/contract.wasm                    # print a Wasm file's SHA-256
npx wasmward add vault build/contract.wasm --label v2    # add it to wasmward.json
npx wasmward check                                       # exit 0 only if every contract is supported
npx wasmward check --min-ttl-days 3                      # ...and none expires within 3 days
npx wasmward watch                                       # print each status change until Ctrl+C
```

One file can describe several networks (for example testnet and mainnet); pass `--network <name>` to pick one. [Details](docs/OPERATIONS.md#several-networks-in-one-config-file).

`check` is meant for a deploy pipeline: run it before releasing an app build to confirm the build's config matches the live contracts. Exit code 0 means all supported, 1 means at least one is not, 2 means invalid input or the network could not be checked. `init` writes a new `wasmward.json` for one contract and never overwrites an existing file. Start it from a build you trust with `--wasm`; without `--wasm` it reads the code that is live on the network now, which means trusting the RPC and whoever deployed it (it says so). [Details](docs/OPERATIONS.md#starting-a-config).

`watch` keeps checking and prints a line whenever a contract's status changes, which is handy while rehearsing an upgrade. Add `--json` for machine-readable output (one JSON object per line for `watch`).

## In GitHub Actions

The repository is also a GitHub Action that runs `wasmward check` and fails the workflow if a contract runs code your config does not support, cannot be checked, or is about to expire:

```yaml
- uses: actions/checkout@v4
- uses: contract-version/Wasmward-backend@main
  with:
    config: wasmward.json   # default
    min-ttl-days: 3         # optional: also fail if a contract has under 3 days left
```

| Input | Default | |
|---|---|---|
| `config` | `wasmward.json` | Path to the config, relative to the workspace. |
| `network` | empty | For a config with a `networks` section, the one network to check. Empty checks every network. |
| `min-ttl-days` | empty | Fail if a supported contract has fewer days left than this. Empty only reports the time left. |

The step's result is the command's exit code (0 all supported, 1 something unsupported or too close to expiring, 2 could not be checked) and the output is also written to the job summary. Until Wasmward is on npm the action builds it from this repository, which takes about a minute, so use a commit or tag in place of `@main` once you want a version that cannot change under you. It is how the [test contract](https://github.com/contract-version/Wasmward-contract) checks itself every week, and how the [browser example](https://github.com/contract-version/Wasmward-frontend) checks the contract it depends on.

## API overview

| | |
|---|---|
| `loadConfig(object)` | Validate a config and apply defaults. `loadConfigFile(path)` is in `@wasmward/core/node`. |
| `hashWasm(bytes)` | SHA-256 of Wasm bytes, equal to the hash Stellar assigns on upload. |
| `createVersionGuard(config)` | The guard: `start`, `stop`, `status`, `isWritable`, `assertWritable`, `assertWritableFresh`, `guard`, `subscribe`, `health`. |
| `WriteBlockedError`, `ConfigError` | What the guard throws. |

Only the `supported` status allows writes. See [docs/API.md](docs/API.md) for every export.

## What it does not do

- It does not stop a write in the moment between an upgrade and the next check. Use `assertWritableFresh` for high-value writes, and simulate transactions before submitting them. [docs/OPERATIONS.md](docs/OPERATIONS.md) explains the limits.
- It does not analyse whether two builds are compatible. That is a decision you make by adding a hash to your config.
- It does not send alerts. Use `guard.subscribe` to wire your own.
- It does not make one RPC outage harmless unless you list spare endpoints in `network.fallbackRpcUrls`; see [docs/OPERATIONS.md](docs/OPERATIONS.md#using-more-than-one-rpc-endpoint).

## Documentation

- [API reference](docs/API.md)
- [Operations guide](docs/OPERATIONS.md): recommended settings, upgrade order, health endpoints, limits
- [Threat model](docs/THREAT-MODEL.md): what it defends against, what it trusts, and what it cannot do
- [Pairing with soroban-upgrade-safeguard](docs/PAIRING.md): a release workflow that checks compatibility first and records the decision in your app
- [Decisions](docs/DECISIONS.md) and [progress log](docs/PROGRESS.md)
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

The test contract and its testnet deploy script live in [Wasmward-contract](https://github.com/contract-version/Wasmward-contract).

## License

Apache-2.0. See [LICENSE](LICENSE).
