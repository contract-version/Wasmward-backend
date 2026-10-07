# Operations guide

How to run Wasmward safely in production, and what it cannot do.

## Recommended settings

| Setting | Default | Guidance |
|---|---|---|
| `pollIntervalMs` | 30000 | Fine for most apps. Use 10000 if writes are high value and you can afford the RPC traffic. The minimum is 5000. |
| `maxStalenessMs` | 4 times the poll interval (120000) | How old the last successful check may be before writes are blocked. It must be at least 2 times the poll interval. |

Things to weigh:

- **One lookup per poll, per process.** All of an app's contracts are checked in a single RPC call (up to 200 contracts). If you run 20 backend instances, that is 20 calls per interval. Check your RPC provider's rate limits.
- **Staleness is a trade between safety and availability.** If the RPC is down for longer than `maxStalenessMs`, every write is blocked, including to contracts that did not change. That is deliberate: the guard cannot tell the difference. A longer limit tolerates longer outages but lets a stale answer stand for longer.
- **Backoff.** When every lookup in a poll fails, the wait doubles each time, up to half of `maxStalenessMs`, so recovery is noticed promptly.
- **Use a dedicated RPC URL you trust.** The guard believes what the RPC says. Do not put an RPC URL that contains an API key in client-side code.

## Upgrading a contract safely

The order matters. A contract that is upgraded before your apps know the new hash will have its writes blocked until they do.

1. **Build the new contract** and compute its hash: `npx wasmward hash build/new.wasm`.
2. **Add the hash to your app's config** and make sure the app really can talk to the new interface:
   ```bash
   npx wasmward add vault build/new.wasm --label v2.0.0
   ```
3. **Release the app** with the updated config. It now supports both the old and new code.
4. **Upgrade the contract.** Apps running the new release carry on; apps still on the old release are blocked, which is the point.
5. **Optionally remove the old hash** in a later release once nothing needs it.

To confirm step 3 before step 4, run `npx wasmward check` against the config in the build you are about to release. It exits 0 only if the live contract is on code that build supports. After step 4, a build that did not add the new hash will exit 1.

### In a deploy pipeline

```bash
npx wasmward check --config wasmward.json
```

- Exit `0`: every contract runs code this config supports. Safe to release.
- Exit `1`: at least one contract runs unsupported code (or is missing, archived or a Stellar Asset Contract). Do not release.
- Exit `2`: the config is invalid, or the network could not be checked. Treat as a failure.

## Limits

Be clear about what a guard can and cannot do.

- **There is always a window.** An upgrade takes effect in the ledger where its transaction is applied. The guard learns of it at its next check, up to one poll interval later (plus jitter of up to 10 percent). A write sent inside that window can reach the new code.
  - For writes where that matters, call `await guard.assertWritableFresh(name)` first, or wrap the function with `guard.guard(name, fn, { fresh: true })`. This does one extra lookup per call and shrinks the window to the lookup itself. It cannot remove it.
  - **Always simulate before you submit.** Simulation runs against the current ledger and fails if the interface changed. The guard is a second line of defence, not a replacement.
- **It checks identity, not compatibility.** A hash on your supported list means *you declared* the app works with that build. Wasmward does not read the contract's interface.
- **It does not see pending upgrades.** If a contract uses a timelock or multisig, you may want to watch for that separately.
- **Contracts that are not Wasm-backed are blocked.** A Stellar Asset Contract is reported `stellar-asset` and a contract using an external-reference executable is reported as an error, because Wasmward cannot verify either.
- **An expired (archived) instance is blocked** until it is restored. The RPC may report an expired instance as missing; both block writes.

## Reading the status

| Status | What to do |
|---|---|
| `supported` | Nothing. |
| `pending` | The first check has not finished, or has only failed. Check the RPC URL and network. |
| `unsupported` | The contract was upgraded to code you have not added. Add the hash if the app is compatible, otherwise release a compatible app first. |
| `missing` | No contract at that ID on this network. Usually a wrong ID or a wrong network. |
| `archived` | The contract instance expired. Restore it. |
| `stellar-asset` | You configured a Stellar Asset Contract, which is not a Wasm contract. Remove it from the config. |
| `stale` | The last good check is too old. The RPC is failing, or the guard was stopped. |

## Health endpoint

`guard.health()` returns plain JSON, so it works with any framework. `ok` is true only when the network is verified and every contract is `supported`. The RPC URL is deliberately not included.

### Express

Wasmward does not depend on Express; this is only an example.

```js
import express from 'express';
import { createVersionGuard } from '@wasmward/core';
import { loadConfigFile } from '@wasmward/core/node';

const guard = createVersionGuard(await loadConfigFile('./wasmward.json'));
await guard.start();

const app = express();

app.get('/health', (_req, res) => {
  const report = guard.health();
  res.status(report.ok ? 200 : 503).json(report);
});

app.post('/deposit', async (req, res) => {
  try {
    await guard.assertWritableFresh('vault');
    // ... build, simulate and submit the transaction
    res.sendStatus(202);
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.listen(3000);
```

### Next.js route handler

Create the guard once per server process, outside the handler. This is an example, not a dependency.

```ts
// lib/guard.ts
import { createVersionGuard, type VersionGuard } from '@wasmward/core';
import { loadConfigFile } from '@wasmward/core/node';

let guard: Promise<VersionGuard> | undefined;

export function getGuard(): Promise<VersionGuard> {
  guard ??= (async () => {
    const created = createVersionGuard(await loadConfigFile('./wasmward.json'));
    await created.start();
    return created;
  })();
  return guard;
}
```

```ts
// app/api/health/route.ts
import { getGuard } from '@/lib/guard';

export async function GET() {
  const report = (await getGuard()).health();
  return Response.json(report, { status: report.ok ? 200 : 503 });
}
```

On serverless platforms a process may live only briefly, so the poller never settles into a rhythm. There, prefer `assertWritableFresh` before each write over relying on polling.

## Getting alerted

Wasmward sends no alerts itself. Use `subscribe`:

```js
guard.subscribe(({ name, from, to, state }) => {
  if (to !== 'supported') {
    notifyOnCall(`'${name}' went ${from} -> ${to}. Live hash: ${state.liveWasmHash ?? 'unknown'}`);
  }
});
```

A listener that throws is ignored and never stops the guard. A change to `stale` caused only by time passing, with checks no longer completing, is not announced; `isWritable` and `health` still report it. Alert on `health().ok` from outside as well.

## Frontends

Use the same `subscribe` call to disable write buttons:

```js
guard.subscribe(({ name, to }) => {
  if (name === 'vault') depositButton.disabled = to !== 'supported';
});
depositButton.disabled = !guard.isWritable('vault');
```

Remember that anything running in a browser can be tampered with by its user. The guard protects honest clients from unexpected upgrades; it is not an access control.
