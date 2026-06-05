# Security Policy

## Reporting a Vulnerability

Wattcoin is an energy-backed cryptocurrency. Security is taken seriously.

If you discover a security vulnerability, please report it privately by emailing **security@wattcoin.ee**.

**Do not** open a public GitHub issue for security vulnerabilities.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Any potential impact

### Response

You will receive an acknowledgment within 48 hours. We will investigate and provide updates as the fix progresses. Once resolved, we will credit the reporter (if desired) in the release notes.

## Scope

- The Electron desktop application (`electron-main.js`, preload, renderer)
- The WTC blockchain node (`wtc-node.js`, consensus, chain, accounts)
- The hardware load controllers and benchmarking
- The PHP APIs (`counter-api`, `sale-api`, `elec-price-api`)
- The build and deploy pipeline

## Out of Scope

- Third-party dependencies (report to the respective maintainers)
- Theoretical attacks without practical exploit paths

## Security Features

See [README.md](README.md#security) for details on built-in security measures including hardware attestation, wallet encryption, IPC allowlist, and binary signing.
