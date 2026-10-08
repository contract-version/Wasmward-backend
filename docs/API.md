# API reference

Everything here is exported from `@wasmward/core`, except `loadConfigFile`, which is exported from `@wasmward/core/node` so browser bundles never import `fs`.

The one rule behind the whole API: **only the `supported` status allows writes**, and a status that cannot be verified or is too old blocks them.

## Quick start

```ts
import { createVersionGuard, loadConfig } from '@wasmward/core';
import { loadConfigFile } from '@wasmward/core/node';

const config = await loadConfigFile('./wasmward.json'); // or loadConfig(object) anywhere
const guard = createVersionGuard(config);
await guard.start(); // verifies the network, runs one check, then keeps checking

const deposit = guard.guard('vault', sendDepositTransaction);
await deposit(amount); // throws WriteBlockedError if the live code is not supported
```

## Config

### Config file format

```json
{
  "version": 1,
  "network": {
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "fallbackRpcUrls": [],
    "passphrase": "Test SDF Network ; September 2015"
  },
  "pollIntervalMs": 30000,
  "maxStalenessMs": 120000,
  "contracts": {
    "vault": {
      "contractId": "C...",
      "supported": [{ "wasmHash": "<64 hex characters>", "label": "v1.0.0" }]
    }
  }
}
```

| Field | Rule |
|---|---|
| `version` | Must equal `1`. |
| `network.rpcUrl` | `https`, or `http` only for `localhost` or `127.0.0.1`. |
| `network.fallbackRpcUrls` | Optional list of up to 4 more RPC URLs, tried in order when the primary cannot answer. Same https rule; no repeats of `rpcUrl` or each other. Default `[]`. See [Using more than one RPC endpoint](OPERATIONS.md#using-more-than-one-rpc-endpoint). |
| `network.passphrase` | Non-empty. `start()` fails if the RPC reports a different one. Every fallback must report the same one before it is used. |
| `pollIntervalMs` | Integer from 5000 to 86400000 (one day). Default 30000. |
| `maxStalenessMs` | Integer, at least 2 times `pollIntervalMs`. Default 4 times `pollIntervalMs`. |
| `contracts` | At least one. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`. |
| `contracts.*.contractId` | A valid contract address (`StrKey.isValidContract`). |
| `contracts.*.supported` | At least one entry; no duplicate hashes. |
| `supported[].wasmHash` | 64 hex characters. Uppercase is lowercased on load. |
| `supported[].label` | Optional, 1 to 64 characters. |

Unknown keys anywhere are rejected, so a typo cannot silently fall back to a default.

### Several networks in one file

A file may describe the same app on more than one network. Instead of the top-level `network`, `pollIntervalMs`, `maxStalenessMs` and `contracts`, give a `networks` section. Each entry has exactly the shape of a single-network config, minus `version`:

```json
{
  "version": 1,
  "networks": {
    "testnet": {
      "network": { "rpcUrl": "https://soroban-testnet.stellar.org", "passphrase": "Test SDF Network ; September 2015" },
      "pollIntervalMs": 10000,
      "contracts": { "vault": { "contractId": "C...", "supported": [{ "wasmHash": "<64 hex>", "label": "v2" }] } }
    },
    "mainnet": {
      "network": { "rpcUrl": "https://rpc.example.org", "passphrase": "Public Global Stellar Network ; September 2015" },
      "contracts": { "vault": { "contractId": "C...", "supported": [{ "wasmHash": "<64 hex>", "label": "v1" }] } }
    }
  }
}
```

- Network names follow the contract-name rule (`^[a-z0-9][a-z0-9-_]{0,63}# API reference

Everything here is exported from `@wasmward/core`, except `loadConfigFile`, which is exported from `@wasmward/core/node` so browser bundles never import `fs`.

The one rule behind the whole API: **only the `supported` status allows writes**, and a status that cannot be verified or is too old blocks them.

## Quick start

```ts
import { createVersionGuard, loadConfig } from '@wasmward/core';
import { loadConfigFile } from '@wasmward/core/node';

const config = await loadConfigFile('./wasmward.json'); // or loadConfig(object) anywhere
const guard = createVersionGuard(config);
await guard.start(); // verifies the network, runs one check, then keeps checking

const deposit = guard.guard('vault', sendDepositTransaction);
await deposit(amount); // throws WriteBlockedError if the live code is not supported
```

## Config

### Config file format

```json
{
  "version": 1,
  "network": {
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "fallbackRpcUrls": [],
    "passphrase": "Test SDF Network ; September 2015"
  },
  "pollIntervalMs": 30000,
  "maxStalenessMs": 120000,
  "contracts": {
    "vault": {
      "contractId": "C...",
      "supported": [{ "wasmHash": "<64 hex characters>", "label": "v1.0.0" }]
    }
  }
}
```

| Field | Rule |
|---|---|
| `version` | Must equal `1`. |
| `network.rpcUrl` | `https`, or `http` only for `localhost` or `127.0.0.1`. |
| `network.fallbackRpcUrls` | Optional list of up to 4 more RPC URLs, tried in order when the primary cannot answer. Same https rule; no repeats of `rpcUrl` or each other. Default `[]`. See [Using more than one RPC endpoint](OPERATIONS.md#using-more-than-one-rpc-endpoint). |
| `network.passphrase` | Non-empty. `start()` fails if the RPC reports a different one. Every fallback must report the same one before it is used. |
| `pollIntervalMs` | Integer from 5000 to 86400000 (one day). Default 30000. |
| `maxStalenessMs` | Integer, at least 2 times `pollIntervalMs`. Default 4 times `pollIntervalMs`. |
| `contracts` | At least one. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`. |
| `contracts.*.contractId` | A valid contract address (`StrKey.isValidContract`). |
| `contracts.*.supported` | At least one entry; no duplicate hashes. |
| `supported[].wasmHash` | 64 hex characters. Uppercase is lowercased on load. |
| `supported[].label` | Optional, 1 to 64 characters. |

Unknown keys anywhere are rejected, so a typo cannot silently fall back to a default.

). Each network has its own settings, contracts and supported hashes, and the same contract name may appear on several networks.
- Every rule for a single-network config applies inside each network. Errors from all networks are listed together, with full paths such as `$.networks.mainnet.contracts.vault.contractId`.
- The two shapes cannot be mixed: a file with `networks` may not also have a top-level `network` or `contracts`.
- **A network is always chosen explicitly.** Picking for you could point an app at mainnet when it meant testnet, so `loadConfig` asks which one, and naming a network for a single-network file is an error too.

### `loadConfig(input, options?)`

```ts
function loadConfig(input: unknown, options?: { source?: string; network?: string }): WasmwardConfig;
```

Validates a plain object and returns one network's settings with defaults applied and hashes lowercased. Works in every runtime. Throws `ConfigError` listing every issue it can evaluate, each with its JSON path. `options.source` names the file in the error message. For a file with a `networks` section, `options.network` names the network to load; without it, or with a name that does not exist, it throws and lists the available names. For a single-network file, `options.network` is an error.

```ts
const config = loadConfig(json, { network: process.env.STELLAR_NETWORK });
```

### `loadConfigDocument(input, options?)`

```ts
type ConfigDocument =
  | { kind: 'single'; config: WasmwardConfig }
  | { kind: 'multi'; networks: Record<string, WasmwardConfig> };

function loadConfigDocument(input: unknown, options?: { source?: string }): ConfigDocument;
```

Validates a config of either shape and returns every network. Use it when a tool should look at all of them, as `wasmward check` does.

### `loadConfigFile(path, options?)` and `loadConfigDocumentFile(path)` (from `@wasmward/core/node`)

```ts
function loadConfigFile(path: string, options?: { network?: string }): Promise<WasmwardConfig>;
function loadConfigDocumentFile(path: string): Promise<ConfigDocument>;
```

Read, parse and validate a JSON file, stripping a leading UTF-8 byte order mark. `loadConfigFile` behaves like `loadConfig`, including the `network` option; `loadConfigDocumentFile` behaves like `loadConfigDocument`. They throw `ConfigError` if the file cannot be read, is not JSON, or fails validation.

### `DEFAULT_POLL_INTERVAL_MS`, `MIN_POLL_INTERVAL_MS`

`30000` and `5000`.

## Hashing

### `hashWasm(bytes)`

```ts
function hashWasm(bytes: Uint8Array): Promise<string>;
```

Returns the lowercase hex SHA-256 of the Wasm bytes, which is the hash Stellar assigns when the Wasm is uploaded. Uses Web Crypto, so it works on Node 20+ and in browsers. Rejects if Web Crypto is unavailable.

## The guard

### `createVersionGuard(config, options?)`

```ts
function createVersionGuard(config: WasmwardConfigInput, options?: {
  server?: GuardServer;            // the primary; defaults to new rpc.Server(config.network.rpcUrl)
  fallbackServers?: GuardServer[]; // defaults to one client per network.fallbackRpcUrls entry
  now?: () => number;              // defaults to Date.now
}): VersionGuard;
```

`WasmwardConfigInput` is `WasmwardConfig` with `network.fallbackRpcUrls` optional. The config is validated again, so a hand-built object cannot skip the schema rules. It takes one network's config: pass a multi-network file through `loadConfig(file, { network })` first, or you get an error that lists the networks. `GuardServer` is the part of `rpc.Server` the guard uses (`getNetwork()` and `getLedgerEntries(...keys)`); a real `rpc.Server` satisfies it.

### `guard.start()`

Calls `getNetwork()` on the primary. If its passphrase differs from the config, throws `ConfigError` and does not poll. If the primary cannot be reached, each fallback is tried in turn; if none can be reached, rejects with `Could not verify the network: ...` naming each endpoint by position. Otherwise runs one check and starts polling. Calling it again while running does nothing. A failed start can be retried.

### `guard.stop()`

Cancels the timer and waits for a check in progress to finish. If it is called while `start()` is still verifying the network, that start is cancelled. The guard can be started again later.

### `guard.status()`

Returns `Record<name, ContractState>`, copies that cannot change the guard. `status` reflects staleness at the moment of the call, so a stopped poller shows `stale` rather than an old `supported`.

```ts
interface ContractState {
  name: string;
  contractId: string;
  status: Status;
  liveWasmHash?: string;     // last Wasm hash seen
  matchedLabel?: string;     // label of the supported version it matched
  lastCheckedAt?: number;    // ms since epoch, last lookup of any outcome
  lastSuccessAt?: number;    // ms since epoch, last lookup that did not error
  lastError?: string;
  consecutiveErrors: number;
}
```

### Statuses

| Status | Meaning | Writable |
|---|---|---|
| `pending` | No successful check yet. | No |
| `supported` | Live Wasm hash is in the supported list and the last success is within `maxStalenessMs`. | **Yes** |
| `unsupported` | Live Wasm hash is not in the supported list. | No |
| `stellar-asset` | The contract is a Stellar Asset Contract. | No |
| `missing` | No instance entry on this network. | No |
| `archived` | The instance's TTL has expired. | No |
| `stale` | The last success is older than `maxStalenessMs`. | No |

### `guard.isWritable(name)`

`true` only when the network is verified and the contract is `supported` with a fresh success. Throws `ConfigError` for an unknown name.

### `guard.assertWritable(name)`

Throws `WriteBlockedError` unless `isWritable(name)`. Throws `ConfigError` for an unknown name.

### `guard.assertWritableFresh(name)`

Runs exactly one lookup for this contract, applies the result, then asserts. If that lookup itself fails, it throws `WriteBlockedError` even when the stored state is still fresh, because the point of a fresh check is certainty. Requires `start()` to have been called.

### `guard.guard(name, write, options?)`

```ts
guard.guard('vault', deposit);                    // asserts before each call
guard.guard('vault', deposit, { fresh: true });   // fresh lookup before each call
```

Returns a function with the same arguments that always returns a promise. It resolves or rejects with whatever `write` does. If the contract is not writable it rejects with `WriteBlockedError` and does not call `write`. An unknown name throws `ConfigError` immediately, when the wrapper is made.

### `guard.subscribe(listener)`

```ts
const unsubscribe = guard.subscribe((change) => {
  // { name, from, to, state }
});
```

Called once per status change, not on every poll. Each listener receives its own copy of the state. A listener that throws or rejects is ignored: it never stops the poller or other listeners.

**Becoming `stale` is announced on time.** A supported contract goes stale just by time passing, so while the guard is running a timer announces `supported -> stale` the moment the last good check becomes more than `maxStalenessMs` old, without waiting for the next poll (which, during an outage, can be well after). Calling `stop()` ends these announcements along with polling; `status()` and `isWritable()` stay correct regardless.

### `guard.health()`

Returns plain JSON, safe to serve from any framework:

```ts
interface HealthReport {
  ok: boolean;                       // network verified and every contract supported
  network: { passphrase: string; verified: boolean; usingFallback: boolean };
  contracts: Record<string, {
    contractId: string;
    status: Status;
    writable: boolean;
    liveWasmHash?: string;
    matchedLabel?: string;
    lastCheckedAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
    consecutiveErrors: number;
  }>;
  checkedAt: number;                 // ms since epoch
}
```

`usingFallback` is true when the latest successful lookup came from a fallback endpoint, which is worth alerting on: you are running on your spare. The RPC URLs are deliberately not included, since they can contain API keys.

## Errors

### `WriteBlockedError`

```ts
class WriteBlockedError extends Error {
  contract: string;
  status: Status;
  liveWasmHash: string | undefined;
  reason: string;
}
```

The message reads, for example: `Writes to 'vault' are blocked: live code a1b2... is not in the supported list` (with the full 64-character hash).

### `ConfigError`

```ts
class ConfigError extends Error {
  issues: readonly { path: string; message: string }[]; // JSON path, e.g. $.contracts.vault.contractId
}
```

Thrown for an invalid config, a network passphrase mismatch, and any unknown contract name.

## Building blocks

These are exported for tools and tests. Most apps only need the guard.

### `fetchExecutables(server, contractIds, timeoutMs)`

Looks up what code each contract instance is running with as few `getLedgerEntries` calls as possible (at most 200 keys each, `MAX_KEYS_PER_REQUEST`). Returns a map with an entry for every requested contract, never throws:

```ts
type LiveExecutable =
  | { kind: 'wasm'; wasmHash: string; liveUntilLedger: number; latestLedger: number }
  | { kind: 'stellar-asset'; latestLedger: number }
  | { kind: 'missing'; latestLedger: number }
  | { kind: 'archived'; liveUntilLedger: number; latestLedger: number }
  | { kind: 'error'; message: string };
```

### `initialState`, `nextState`, `effectiveStatus`, `isWritable`

The pure status model. `nextState(prev, result, contractConfig, now, maxStalenessMs)` computes the next state; `effectiveStatus` and `isWritable` apply the call-time staleness rule. `describeBlock` produces the reason text used in `WriteBlockedError` (internal to the package, not exported from the main entry).

### `createRpcClient(url, timeoutMs)`

```ts
function createRpcClient(url: string, timeoutMs: number): GuardServer;
const CLIENT_ABORT_SLACK_MS: number; // 1000
```

The RPC client the guard and the CLI use by default: a Stellar `rpc.Server` whose requests are really cancelled after `timeoutMs` plus a second of slack. Use it if you build your own `GuardServer` and want the same behaviour. A plain `rpc.Server` never abandons a request: its `timeout` option is not read by @stellar/stellar-sdk 17.2.1, so a hung RPC would keep its connection open (and keep a short-lived process such as a script alive) indefinitely. Plain http is allowed for `http://` URLs of any letter case; the config decides which hosts may use it.

### `createEndpointSet(servers, passphrase, timeoutMs)`

The failover logic behind the guard and `wasmward check`. Takes the primary and fallbacks as `GuardServer`s and returns `{ verifyNetwork(), lookup(contractIds, timeoutMs), usingFallback }`. With one server it behaves exactly like that server alone.

### `createPoller`, `nextDelayMs`, `MAX_TIMER_MS`

The timer chain behind the guard. `createPoller({ intervalMs, maxStalenessMs, tick })` returns `{ start, stop }`; `nextDelayMs` computes the wait (interval, doubled per failing tick, capped at half of `maxStalenessMs`, plus up to 10 percent jitter). `MAX_TIMER_MS` (about 24.8 days) is the longest a timer can wait; delays are never longer than that.
