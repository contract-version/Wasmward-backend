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
| `pollIntervalMs` | Integer, at least 5000. Default 30000. |
| `maxStalenessMs` | Integer, at least 2 times `pollIntervalMs`. Default 4 times `pollIntervalMs`. |
| `contracts` | At least one. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`. |
| `contracts.*.contractId` | A valid contract address (`StrKey.isValidContract`). |
| `contracts.*.supported` | At least one entry; no duplicate hashes. |
| `supported[].wasmHash` | 64 hex characters. Uppercase is lowercased on load. |
| `supported[].label` | Optional, 1 to 64 characters. |

Unknown keys anywhere are rejected, so a typo cannot silently fall back to a default.

### `loadConfig(input, options?)`

```ts
function loadConfig(input: unknown, options?: { source?: string }): WasmwardConfig;
```

Validates a plain object and returns it with defaults applied and hashes lowercased. Works in every runtime. Throws `ConfigError` listing every issue it can evaluate, each with its JSON path. `options.source` names the file in the error message.

### `loadConfigFile(path)` (from `@wasmward/core/node`)

```ts
function loadConfigFile(path: string): Promise<WasmwardConfig>;
```

Reads, parses and validates a JSON file. Strips a leading UTF-8 byte order mark. Throws `ConfigError` if the file cannot be read, is not JSON, or fails validation.

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

`WasmwardConfigInput` is `WasmwardConfig` with `network.fallbackRpcUrls` optional. The config is validated again, so a hand-built object cannot skip the schema rules. `GuardServer` is the part of `rpc.Server` the guard uses (`getNetwork()` and `getLedgerEntries(...keys)`); a real `rpc.Server` satisfies it.

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

Called once per status change, not on every poll. Each listener receives its own copy of the state. A listener that throws or rejects is ignored: it never stops the poller or other listeners. Changes are reported when a check completes, so with the poller stopped, becoming `stale` through time alone is not announced; `status()` and `isWritable()` still report it.

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

### `createEndpointSet(servers, passphrase, timeoutMs)`

The failover logic behind the guard and `wasmward check`. Takes the primary and fallbacks as `GuardServer`s and returns `{ verifyNetwork(), lookup(contractIds, timeoutMs), usingFallback }`. With one server it behaves exactly like that server alone.

### `createPoller`, `nextDelayMs`

The timer chain behind the guard. `createPoller({ intervalMs, maxStalenessMs, tick })` returns `{ start, stop }`; `nextDelayMs` computes the wait (interval, doubled per failing tick, capped at half of `maxStalenessMs`, plus up to 10 percent jitter).
