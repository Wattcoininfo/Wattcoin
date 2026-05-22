# Mainnet Upgrade And Governance Procedure

## Policy

- Mandatory upgrade path: N -> N+1 only.
- Compatibility window: N and N+1 may interoperate for 14 days.
- Emergency release: N+2-hotfix allowed only for critical incidents.

See also:
- `docs/mainnet-node-provisioning.md` for per-node override and token rotation requirements.
- `docs/mainnet-monitoring.md` for the external alerting and retention requirements that must be in place before rollout.

## Release Gates

All gates must pass before production rollout:
- npm run test:p2p-adversarial
- npm run test:ledger
- npm run mainnet:durability:snapshot
- npm run mainnet:durability:corruption
- npm run mainnet:validate-seeds
- npm run mainnet:upgrade-gates

## Operator Drill (End-To-End)

Primary command:
- `npm run mainnet:upgrade-drill -- --node-a-tip http://node-a:39310/api/v1/chain/tip --node-b-tip http://node-b:39310/api/v1/chain/tip --node-a-health http://node-a:39310/api/v1/ops/health --node-b-health http://node-b:39310/api/v1/ops/health`

Protected endpoint variant:
- `npm run mainnet:upgrade-drill -- --auth-token <ledger-token> --node-a-tip http://node-a:39310/api/v1/chain/tip --node-b-tip http://node-b:39310/api/v1/chain/tip --node-a-health http://node-a:39310/api/v1/ops/health --node-b-health http://node-b:39310/api/v1/ops/health`

Checklist-only automated gate run:
- `npm run mainnet:upgrade-drill -- --gates-only`

Evidence capture command:
- `npm run mainnet:upgrade-evidence -- --auth-token <ledger-token> --node-a-tip http://node-a:39310/api/v1/chain/tip --node-b-tip http://node-b:39310/api/v1/chain/tip --node-a-health http://node-a:39310/api/v1/ops/health --node-b-health http://node-b:39310/api/v1/ops/health`

1. Stage node A at current release N.
2. Stage node B at candidate release N+1.
3. Verify protocol compatibility via /api/v1/chain/tip metadata.
4. Run normal sync and mining for 30 minutes.
5. Trigger controlled rollback: return node B to N.
6. Confirm node B rejoins and reaches zero lag.
7. Re-upgrade B to N+1 and verify again.

Pass criteria:
- no permanent divergence
- rollback depth remains bounded and observable
- node lag converges to 0 after each transition

Script behavior:
- Runs all automated release gates first.
- Sends `x-wattcoin-ledger-token` when `--auth-token` is provided, so the same command works against protected staging endpoints.
- Verifies tip compatibility automatically when both tip URLs are provided.
- Verifies `nodeLagBlocks == 0` automatically when health URLs are provided.
- Writes a timestamped artifact folder under `artifacts/mainnet-upgrade-drill/` when `--capture-evidence` is enabled or when `npm run mainnet:upgrade-evidence` is used.
- Falls back to explicit operator confirmation prompts for any step without URLs.

## Emergency Release Process

1. Incident commander declares emergency and freeze window.
2. Build emergency package from signed tag.
3. Publish release notes with explicit operator actions.
4. Roll out to canary peers first.
5. If canary stable, roll out to remaining peers in waves.
6. If canary fails, execute bad release rollback runbook immediately.

## Governance Controls

- Parameter changes require documented RFC and operator notice period.
- Consensus-critical changes require quorum signoff by maintainers.
- Mainnet freeze applies 72 hours before major release.
