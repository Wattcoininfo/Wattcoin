# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `npm install`
4. Run `npm run electron:dev` for hot-reload development

## Code Style

- **JavaScript/JSX:** Standard ESLint rules — run `npm run lint` before committing
- **Formatting:** Prettier with `--check` in CI — run `npm run format` before committing
- **No trailing commas in function params** (Prettier handles this)
- **No semicolons** (Prettier handles this)

## Testing

All changes must pass existing tests:

```bash
npm test
```

For test-specific scripts:

```bash
npm run test:ledger           # Ledger integration
npm run test:staking          # Staking queue
npm run test:p2p-adversarial  # P2P adversarial scenarios
npm run test:counterfeit      # Counterfeit/spoofing
```

## Commit Messages

- Use clear, descriptive commit messages
- Reference issues and PRs where applicable
- Keep commits focused on a single change

## Pull Requests

1. Ensure all tests pass
2. Run `npm run lint` and `npm run format:check`
3. Update the README if your change introduces new features or modifies the API
4. Open a PR against the `master` branch

## Security

If you find a security vulnerability, **do not** open a public issue. Email **security@wattcoin.ee** instead.

## Questions

Open a GitHub Discussion or visit [wattcoin.ee](https://wattcoin.ee).
