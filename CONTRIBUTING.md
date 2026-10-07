# Contributing to Wasmward

Thanks for helping. Wasmward is a small library with one job and one rule: **only a `supported` contract may be written to, and anything that cannot be verified blocks writes.** Changes that weaken that rule will not be accepted.

## Setup

You need Node.js 20 or 22 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/contract-version/Wasmward-backend.git
cd Wasmward-backend
pnpm install
pnpm build
```

## Running checks

```bash
pnpm lint             # ESLint
pnpm typecheck        # strict TypeScript
pnpm build            # ESM, CJS, type declarations and the CLI
pnpm test             # unit, replay and CLI tests
pnpm test:coverage    # the same, with the 90% line coverage gate
```

The CLI tests run the built `dist/cli.js`, so run `pnpm build` first.

### Testnet integration tests

These upgrade a real contract on Stellar testnet. They need the fixture from the [Wasmward-contract](https://github.com/contract-version/Wasmward-contract) repository, cloned next to this one:

```bash
cd ../Wasmward-contract
bash scripts/deploy.sh        # needs the Stellar CLI; generates a testnet identity if you have none
cd ../Wasmward-backend
pnpm test:integration
```

Without the fixture these tests skip and say why. Never use a mainnet key; the fixture only ever needs a funded testnet account, and secrets stay in `.env`, which is git-ignored.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `refactor:`. Keep each commit to one logical change.

## Pull requests

Before you open one, check that:

- [ ] Tests are added or updated and `pnpm test:coverage` passes.
- [ ] `pnpm lint` and `pnpm typecheck` are clean. Please do not disable a rule or a test to get there.
- [ ] Docs are updated (`docs/API.md` for public changes, `docs/OPERATIONS.md` for behaviour users rely on).
- [ ] A choice the spec left open, or a deviation from it, is recorded in `docs/DECISIONS.md`.
- [ ] The PR links the issue it closes.

Some ground rules:

- **Fail closed.** If the code cannot prove something is safe, it must say so and must never report success by default.
- **Keep dependencies out.** The only runtime dependency besides the Stellar SDK is `zod`. Pin exact versions and record them in `VERSIONS.md`.
- **Browser-safe core.** Nothing Node-only may be reachable from the main entry point. Node code lives in `@wasmward/core/node` or the CLI.

## Picking up an issue

Comment on the issue you would like to work on and wait for a maintainer to assign it to you, so two people do not build the same thing. Each scoped issue lists acceptance criteria and the files it expects to touch. If you are unsure, ask on the issue before writing code.

## Stellar Wave

Issues labeled for the Stellar Wave are part of the [Drips](https://www.drips.network) Wave program. They are scoped, have clear acceptance criteria, and are the best place to start. Follow the steps above to request assignment, and keep your pull request limited to what the issue describes.

## Reporting security problems

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
