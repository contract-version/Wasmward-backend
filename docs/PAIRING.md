# Using Wasmward with soroban-upgrade-safeguard

[soroban-upgrade-safeguard](https://github.com/ShippedLabs/soroban-upgrade-safeguard) and Wasmward cover two different moments of an upgrade, and they work best together in one release workflow.

| | soroban-upgrade-safeguard | Wasmward |
|---|---|---|
| **When** | Before the upgrade, in CI | Before the release in CI, and at runtime in your app |
| **Question it answers** | Is the new build safe for existing callers? | Does this app know about the code the contract is running? |
| **How** | Compares two Wasm builds: interface, storage layout, permissions | Compares the live Wasm hash with your supported list |
| **If the answer is no** | Fails the pipeline | Fails the pipeline, and blocks writes in running apps |

safeguard decides whether an upgrade *should* go ahead. Wasmward is how that decision is recorded in your app (`wasmward add`) and enforced while the app runs. Neither replaces the other:

- A safeguard pass says nothing about what your deployed apps support. Without Wasmward, an old app keeps sending calls to code it was never checked against.
- A Wasmward pass says nothing about whether the new code is compatible. It only proves the app's config lists that exact build.

Wasmward does not read safeguard's reports or its interface lockfile (D-003 in `docs/DECISIONS.md`): a lockfile pins an *interface*, while the chain only reveals a *Wasm hash*, so the two meet at the build you are about to deploy.

> **What was tested.** Every `wasmward` command and output on this page was run against the Wasmward test contract on Stellar testnet. The `soroban-upgrade-safeguard` commands are taken from that project's README (flags checked against it, not executed here). It is a young project, so read its README for current flags before you copy them.

## The release workflow, in order

The order that keeps apps working is the one in the [operations guide](OPERATIONS.md#upgrading-a-contract-safely): make the app support the new code *before* the contract changes.

### 1. Build the candidate and hash it

```bash
npx wasmward hash build/new.wasm
# ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875
```

Use the hash of the artifact you will actually upload (see [Which hash to put in the config](OPERATIONS.md#which-hash-to-put-in-the-config)).

### 2. Learn what is live

`wasmward check --json` reports the live hash of every configured contract:

```bash
npx wasmward check --json --config wasmward.json
```

```json
{ "ok": true, "exitCode": 0,
  "contracts": { "vault": { "status": "supported", "liveWasmHash": "a7a82511fa28...", "...": "..." } } }
```

The exit code is 0 when everything is supported, 1 when something is not, and 2 on a configuration or network error. Here you only want the live hash, so a 1 must not stop the script. Shells run with `-e -o pipefail`, as GitHub Actions does, treat a non-zero `check` inside a pipeline as a failure, so keep it out of the pipe:

```bash
JSON=$(npx wasmward check --json --config wasmward.json || true)
LIVE=$(echo "$JSON" | jq -r '.contracts.vault.liveWasmHash')
[ "$LIVE" != "null" ] || { echo "could not read the live hash: $JSON" >&2; exit 1; }
```

When the call itself fails (exit 2) the JSON has `"ok": false` and an `error` message and no `contracts`, so `LIVE` is `null` and the guard above stops the script with the reason.

### 3. Ask safeguard whether the new build is safe

safeguard can fetch the deployed build over RPC and compare it with your candidate. `--expected-wasm-hash` pins the baseline, so the comparison fails if the RPC answered with anything other than the bytes whose hash Wasmward just reported:

```bash
soroban-upgrade-safeguard \
  --contract-id "$CONTRACT_ID" \
  --rpc-url https://soroban-testnet.stellar.org \
  --expected-wasm-hash "$LIVE" \
  --strict \
  build/new.wasm
```

Per its README, it exits 0 when there are no critical findings (with `--strict`, no warnings either) and 1 otherwise, which includes a baseline hash mismatch. A non-zero exit ends the release here.

### 4. Record the decision in the app config

Once you are satisfied the app works with the new code, add its hash:

```bash
npx wasmward add vault build/new.wasm --label v2.0.0
```

```text
Added v2.0.0 (ec040ead...) to 'vault' in wasmward.json
```

`add` validates the file before and after the edit, refuses a duplicate, and writes it atomically, so a failed run never leaves a half-written config. Commit the change and release the app.

### 5. Check before touching the contract

Running `check` with the **new** config while the contract is still on the **old** code must pass, because both hashes are now supported:

```bash
npx wasmward check --config wasmward.json
```

```text
vault  supported (v1)  a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509
1 of 1 contracts supported.
```

Exit 0 means the released app already tolerates the current contract and will tolerate the new one.

### 6. Upgrade the contract, then check again

Run your own upgrade step. Afterwards the same command proves the live code is one the released config supports:

```bash
npx wasmward check --config wasmward.json   # must exit 0
```

If you are rehearsing on testnet, `npx wasmward watch` prints the transition as it happens.

## Putting it in GitHub Actions

A sketch of the two checks around the contract upgrade. Replace the build, install and upgrade steps with your own.

```yaml
name: Contract release

on:
  workflow_dispatch:

jobs:
  release:
    runs-on: ubuntu-latest
    env:
      CONTRACT_ID: C...                       # your contract
      RPC_URL: https://soroban-testnet.stellar.org
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Build the candidate however you normally do. It must produce build/new.wasm.
      - name: Build the candidate
        run: ./scripts/build-contract.sh      # yours

      - name: Hash it and find the live hash
        id: hashes
        run: |
          echo "new=$(npx wasmward hash build/new.wasm)" >> "$GITHUB_OUTPUT"
          json=$(npx wasmward check --json || true)   # exit 1 just means something is unsupported
          live=$(echo "$json" | jq -r '.contracts.vault.liveWasmHash')
          [ "$live" != "null" ] || { echo "could not read the live hash: $json" >&2; exit 1; }
          echo "live=$live" >> "$GITHUB_OUTPUT"

      # Install soroban-upgrade-safeguard as its README describes, and pin a version.
      - name: Is the new build safe for existing callers?
        run: |
          soroban-upgrade-safeguard \
            --contract-id "$CONTRACT_ID" --rpc-url "$RPC_URL" \
            --expected-wasm-hash "${{ steps.hashes.outputs.live }}" \
            --strict build/new.wasm

      - name: Teach the app about the new build
        run: |
          npx wasmward add vault build/new.wasm --label "${{ github.ref_name }}"
          # Commit wasmward.json and ship the app, then continue once it is live.

      - name: The released config must support what is live now
        run: npx wasmward check

      - name: Upgrade the contract
        run: ./scripts/upgrade-contract.sh    # yours

      - name: The released config must support what is live after the upgrade
        run: npx wasmward check
```

## Things to know

- **An interface-compatible upgrade still needs `wasmward add`.** A bug-fix upgrade that does not change the interface will pass safeguard, but its Wasm hash is new, so Wasmward blocks writes until the hash is added. That is deliberate: Wasmward cannot tell a harmless rebuild from a harmful one, and an unknown hash fails closed. Safeguard's verdict is your reason to add it.
- **The baseline is the deployed file.** For `--expected-wasm-hash` and for `wasmward add`, use hashes of the artifacts that were actually uploaded. The same source can build to different Wasm on different machines.
- **A hash on the list is a promise from you, not from safeguard.** Add a hash only after the app has been exercised against that build, for example on testnet.
- **Their lockfile and ours are different things.** safeguard's interface lockfile pins what a contract exposes; Wasmward's `wasmward.json` lists which builds an app will talk to. You can use both.
