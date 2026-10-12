# Command line reference

`wasmward` is the command line tool in `@wasmward/core`. `wasmward --help` prints the same list of commands and options as this page; a test keeps the two from disagreeing.

```text
wasmward <command> [options]
```

Every command reads or writes a config file, `./wasmward.json` unless you pass `--config <path>`. A config can hold one network, or a `networks` section with several; see [Operations](OPERATIONS.md). With several, name the one you mean with `--network <name>`. The tool never guesses between them, because guessing could point a command at mainnet when you meant testnet.

## Commands

| Command | What it does | Contacts the network |
|---|---|---|
| [`init`](#init) | Creates a config for one contract. | Only without `--wasm` |
| [`hash`](#hash) | Prints the SHA-256 of a Wasm file. | No |
| [`add`](#add) | Adds a Wasm file's hash to a contract's supported list. | No |
| [`remove`](#remove) | Takes a build off a contract's supported list. | No |
| [`validate`](#validate) | Checks the config file alone. | No |
| [`check`](#check) | Looks up what each contract runs now and reports its status. | Yes |
| [`watch`](#watch) | Keeps checking and prints each status change. | Yes |

Commands that do not contact the network start instantly, because the Stellar SDK is loaded only by the ones that need it.

### init

```bash
wasmward init <name> <contract-id> (--preset <testnet|mainnet> | --rpc-url <url> --passphrase <text>)
              [--wasm <file.wasm>] [--label <label>] [--config <path>] [--json]
```

Creates the config with one contract and one supported build. The build comes from `--wasm` (the hash of a file you trust, no network involved) or, without it, from the code that is live on the network now. The second is a decision to trust the RPC and whoever deployed the contract, and `init` says so. `--preset testnet` includes the public RPC; `--preset mainnet` needs your own `--rpc-url`. The label defaults to `initial`. `init` never overwrites a file: it stops before any network work if the file exists.

### hash

```bash
wasmward hash <file.wasm> [--json]
```

Prints the lowercase SHA-256 of the file, which equals the hash Stellar assigns the code on upload. With `--json`: `{"file": "...", "wasmHash": "..."}`.

### add

```bash
wasmward add <name> <file.wasm> --label <label> [--config <path>] [--network <name>] [--json]
```

Adds the file's hash, with the label, to the contract's supported list. It refuses a hash that is already listed. The config is rewritten atomically (a temporary file, then a rename), so a reader never sees half a file, and keeps its own key order. With `--json`: `{"contract", "network"?, "wasmHash", "label", "config"}`.

### remove

```bash
wasmward remove <name> <label-or-hash> [--config <path>] [--network <name>] [--json]
```

Takes one build off the supported list, chosen by its label or by its 64-character hash. It refuses to remove the only build of a contract (a contract nothing can write to is never what a release means), a label that two builds share (use the hash), and anything on an invalid config. When it refuses, the file is untouched. With `--json`: `{"contract", "network"?, "wasmHash", "label"?, "config"}`.

### validate

```bash
wasmward validate [--config <path>] [--json]
```

Reads the config and either lists what is in it (networks, contracts, supported builds) or fails with every problem and its JSON path. It never contacts a network, so it suits a pre-commit hook. With `--json`: `{"ok": true, "config", "networks": [{"name"?, "rpcUrl", "contracts": [{"name", "contractId", "supported"}]}]}`; on failure `{"ok": false, "error", "exitCode": 2}`.

### check

```bash
wasmward check [--config <path>] [--network <name>] [--min-ttl-days <days>] [--json]
```

Verifies the RPC serves the configured network, looks up the live code of every contract and prints its status. With a several-networks config and no `--network`, every network is checked, and one failing does not hide the others. `--min-ttl-days` also fails a supported contract with fewer than that many days left (fractions are fine). The days left are the smaller of the contract instance's and its Wasm code's, which expire separately.

With `--json` the output is the health report from `guard.health()` (see [API](API.md)) plus `exitCode`, `minTtlDays` when a minimum was given, and `belowMinTtl: true` on each contract that misses it. For several networks the object is `{"ok", "exitCode", "networks": {"<name>": {...}}}`.

### watch

```bash
wasmward watch [--config <path>] [--network <name>] [--json]
```

Starts a guard and prints a line whenever a contract's status changes, until you press Ctrl+C or the process gets SIGTERM, which end it cleanly. With `--json` each line is an object: `{"time", "contract", "from", "to", "network"?, "liveWasmHash"?, "matchedLabel"?, "reason"?}`.

## Options

| Option | Used by | Meaning |
|---|---|---|
| `--config <path>` | all but `hash` | The config file. Default `./wasmward.json`. |
| `--network <name>` | `add`, `remove`, `check`, `watch` | Which network, for a config with a `networks` section. |
| `--label <label>` | `init`, `add` | Name for the build being added. `add` requires it; `init` defaults to `initial`. |
| `--preset <name>` | `init` | `testnet` (public RPC included) or `mainnet` (give `--rpc-url`). |
| `--rpc-url <url>` | `init` | The RPC endpoint. |
| `--passphrase <text>` | `init` | The network passphrase, when not using `--preset`. |
| `--wasm <file>` | `init` | Take the first supported hash from this build instead of the network. |
| `--min-ttl-days <n>` | `check` | Also fail if a supported contract has fewer than `n` days left. |
| `--json` | all | Machine-readable output: one JSON object (or one per line for `watch`). Errors become `{"ok": false, "error", "exitCode"}`. |
| `-v`, `--version` | | Print the version and exit. |
| `-h`, `--help` | | Print the help and exit. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. For `check`: every contract is supported (and has enough time left, with `--min-ttl-days`). For `watch`: stopped by Ctrl+C. |
| `1` | `check` only: at least one contract is not supported, or is too close to expiring. |
| `2` | Invalid input, an unreadable file, an invalid config, or the network could not be checked. For `watch`, also if it cannot start. |

When one `check` finds both a failure and a contract that could not be checked, the higher code wins: 2, then 1, then 0.
