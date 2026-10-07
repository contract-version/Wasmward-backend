# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub Security Advisories:

<https://github.com/contract-version/Wasmward-backend/security/advisories/new>

Do not open a public issue or pull request for a vulnerability. Include what you found, how to reproduce it, and the version affected. We will work with you on a fix and agree a time to disclose it.

## What counts

Wasmward is a guard that blocks writes to contracts running unknown code. The reports that matter most are the ones where it **allows a write it should have blocked**, for example:

- a status other than `supported` that lets `isWritable` return true;
- a stale, failed, or unverifiable check that is still treated as fresh;
- a way for a response from the RPC to make an unsupported or missing contract look `supported`;
- a configuration that passes validation but disables a check;
- a secret or RPC URL leaking through health output or an error message.

Weaknesses that follow from a documented limit are not vulnerabilities, such as a write sent between an upgrade and the next check (see [docs/OPERATIONS.md](docs/OPERATIONS.md)), or a compromised RPC endpoint that you chose to trust.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Earlier than 0.1.0 | No |

Only the latest minor release receives fixes while the project is pre-1.0.
