# Threat model

What Wasmward protects against, what it trusts, and what it cannot do. It is written for people deciding whether to rely on it, and for anyone reviewing it for security.

## The guarantee

A write is allowed only when **all** of these hold:

1. `start()` has confirmed that an RPC endpoint serves the configured network.
2. The most recent successful lookup is no more than `maxStalenessMs` old, checked again at the moment of the call.
3. That lookup reported that the contract runs Wasm whose SHA-256 is on the app's supported list.

Every other situation blocks writes: an unknown hash, a contract that does not exist, an expired instance, a Stellar Asset Contract, an unreachable or erroring RPC, a stopped poller, a stale answer, a wrong network, a clock that has moved backwards. There is no state in which a failure leaves writes enabled. This is the only claim the project makes, and it is the one the tests are built around.

It is a **client-side check made at one moment**. It is not a transaction-level guarantee, which is why the limits below matter.

## What it defends against

| Threat | How it is handled |
|---|---|
| A contract is upgraded to code the app was never tested with (by its admin, a compromised admin key, or a governance action) | The live hash is no longer on the list, so writes are blocked within one poll interval (plus up to 10% jitter). Measured on testnet with a 5 s interval: noticed 0.7 to 0.8 s after the upgrade was confirmed in local runs, and 3.8 s on a hosted CI runner. The bound is one interval plus jitter, not a fixed delay. |
| The RPC goes down, hangs or returns errors | Writes stay allowed only until the last good answer is `maxStalenessMs` old, then are blocked. Requests are really cancelled after their timeout, so a hung RPC cannot pile up connections or keep a process alive (D-023). |
| An old answer is mistaken for a current one | Freshness is judged at call time, so a stopped or hung poller cannot leave a stale `supported` in place. A slow lookup that finishes late cannot overwrite a newer result. Freshness is dated from when a lookup began, never when it ended. |
| The config points at the wrong network (a testnet RPC for a mainnet contract, a mistyped URL) | The RPC must report the configured network passphrase. A primary that does not is a configuration error and stops `start()`, including on retry. A fallback that does not is rejected permanently and never used (D-018, D-022). |
| The app is pointed at mainnet by accident when testnet was meant | With several networks in one file, a network must always be named; there is no default, and naming one for a single-network file is an error (D-019). |
| A typo in the config silently weakens a check | Unknown keys are rejected, every rule is validated with the JSON path of each problem, and `createVersionGuard` validates again so a hand-built object cannot skip the rules. |
| A hash written in different letter case is missed or duplicated | Hashes are normalised to lowercase, and duplicates are detected after normalisation. |
| Plain `http` used against a real RPC | `http` is accepted only for `localhost` and `127.0.0.1`, however the scheme is spelled. |
| The system clock is wrong | A clock that moves backwards, or a time that is not a number, makes the contract `stale`, so writes are blocked. A clock that jumps forward makes answers look older, which also blocks. |
| A caller or listener changes the guard's state through an object it was handed | `status()` and the state passed to each listener are copies. |
| The config file is edited by a failed or concurrent write | `wasmward add` validates before and after, and writes atomically; `init` never overwrites and creates the file whole or not at all. |

## What it trusts

These are assumptions, not defences. If one fails, the guarantee can fail with it.

- **The RPC tells the truth.** Wasmward believes the Wasm hash the RPC reports. Checking the network passphrase proves the endpoint *claims* to serve the right network; it does not authenticate what it says. An RPC operator, or anyone who can intercept an unauthenticated connection, could make an unsupported contract look supported. Use `https`, and for high-value flows an endpoint you run or fully trust.
- **Every listed endpoint is trusted equally.** Fallback endpoints are not compared with the primary. Adding a fallback you trust less than the primary lowers the guarantee to that of the weakest endpoint (D-018).
- **Simulation does not add independence.** Simulating a transaction asks the same RPC, so it is a useful check against interface changes but not against a lying RPC.
- **The config is reviewed.** Whoever can change `wasmward.json`, or the bundle that contains it, decides what is supported. Treat changes to supported hashes like changes to access rules: review them, and take hashes from the artifacts that were actually deployed (see [the operations guide](OPERATIONS.md#which-hash-to-put-in-the-config)).
- **`wasmward init` without `--wasm` trusts what is live today.** It says so every time (D-021).
- **A hash on the list is a promise from you.** Wasmward checks identity, not behaviour. Listing a hash means *you* declared the app works with that build.
- **The runtime is honest.** In a browser, a user can change the page, so this protects honest clients; it is not access control.

## What it cannot do

- **Close the window around an upgrade.** An upgrade takes effect in the ledger where its transaction is applied. A write sent after that and before the next check can reach the new code. `assertWritableFresh` shrinks the window to one lookup; nothing removes it.
- **Check compatibility.** It does not read a contract's interface, storage layout or behaviour. For that, use a tool such as soroban-upgrade-safeguard before you add a hash ([pairing guide](PAIRING.md)).
- **See other contracts.** If a listed contract calls another contract that gets upgraded, only the listed one is guarded. List every contract your app depends on.
- **Read the Wasm code itself.** The instance names the build by its hash, and that hash is what Wasmward compares. It also looks up the separate ledger entry that holds the Wasm, but only for its lifetime: the bytes are never read or re-hashed. If the RPC lied about the hash, nothing here would notice (see "What it trusts").
- **Act on a contract that is about to expire.** It records how long the instance and the Wasm code each had left at the last check, and `wasmward check` shows the smaller of the two, with a nudge under about a week, but this never changes a status or blocks a write by itself. It reports `archived`, and blocks writes, once either entry's lifetime has ended (or the code entry cannot be found), because from then on calls fail. `check --min-ttl-days` turns the warning into a gate.
- **See a pending upgrade** (a timelock or multisig that has not executed yet).
- **Protect a transaction already submitted.** It gates the decision to send.
- **Verify what an external-reference executable runs.** Those contracts are reported as an error and blocked.

## Failure behaviour at a glance

| Situation | Status | Writes |
|---|---|---|
| Live hash is on the list, last success fresh | `supported` | allowed |
| Live hash not on the list | `unsupported` | blocked |
| No contract at that ID | `missing` | blocked |
| Instance expired | `archived` | blocked (the RPC may report an expired instance as `missing`; both block) |
| Stellar Asset Contract | `stellar-asset` | blocked |
| No successful check yet | `pending` | blocked |
| Last success too old, or the clock went backwards | `stale` | blocked |
| RPC unreachable, erroring or too slow | unchanged until staleness, then `stale` | blocked once stale |
| Primary RPC on the wrong network | `start()` throws `ConfigError` | blocked (nothing runs) |
| Guard not started, or network not verified | `pending` | blocked |

## Other things worth knowing

- **Information exposure.** The health report leaves out RPC URLs, because providers often put API keys in them, and errors name endpoints by position. The text of an underlying client error is passed through as the client produced it, so treat `lastError` as potentially sensitive if your RPC client puts URLs in its messages.
- **Denial of service.** Making the RPC unreachable blocks writes after `maxStalenessMs`. That is the intended fail-closed behaviour and also the cost of it; spare endpoints are the mitigation, at the price of trusting them.
- **Dependencies.** The only runtime dependencies are `zod` and the Stellar SDK (a peer dependency). The SDK's `rpc.Server` timeout option is not honoured in 17.2.1, so a workaround is used and tested (D-023).
- **Supply chain.** The release workflow publishes with npm provenance from a tag that must match the package version. Versions are pinned and recorded in `VERSIONS.md`.

## How the claims are checked

The guarantee and the failure table are covered by tests, not just stated: the status table by `test/unit/state.test.ts` (every result from every status, the call-time staleness check, the backwards clock), the guard by `test/unit/guard.test.ts` (a stopped poller cannot stay writable, a failed start does not leave anything writable, a fresh check fails closed), fail-over and the wrong-network rule by `test/unit/endpoints.test.ts` and `test/unit/review-fixes.test.ts`, and real behaviour against Stellar testnet by `test/integration`, including a real contract upgrade. Bugs found by reading the code back are listed in [DECISIONS.md](DECISIONS.md) (D-022), each with a regression test that was shown to fail without its fix.

To report a weakness, see [SECURITY.md](../SECURITY.md).
