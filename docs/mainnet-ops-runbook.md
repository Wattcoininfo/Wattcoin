# Mainnet Operations Runbook

## Scope

This runbook covers incident response for:
- chain stall
- peer poisoning / eclipse pressure
- bad release rollback

See also:
- `docs/mainnet-monitoring.md` for polling, retention, and alert routing requirements.
- `docs/mainnet-node-provisioning.md` for token rotation and per-node override handling.

## Release Shipping Gate

Before shipping any installer:
- stop and review `electron-builder.config.js`
- confirm every new main-process/runtime file is present in `files` or `extraResources`
- remember that this project uses an explicit allowlist, so new runtime modules are not packaged automatically
- do not ship or upload the installer until that packaging review is complete

## Required Monitoring Inputs

Collect from the node:
- GET /api/v1/ops/health
- GET /api/v1/ops/metrics
- userData/ops-metrics.json
- userData/abuse-events.jsonl

Track these fields continuously:
- forkRatePerHour
- rollbackMedianDepth
- peerHealthy/peerTotal
- mempoolPressure
- blockIntervalMedianSec
- nodeLagBlocks

## Alert Thresholds

- `chain.stall`: latestBlockAgeMs >= 20 minutes
- `peer.diversity.low`: unique network segments < 3 while peerTotal >= 3
- `mempool.pressure.high`: pressure >= 0.85
- rollback warning: rollback depth >= 3
- critical if `forkRatePerHour > 3` for 15 minutes

## Incident: Chain Stall

1. Confirm status with GET /api/v1/ops/health.
2. Check if nodeLagBlocks is rising.
3. Compare local height vs bestPeerHeight from GET /api/v1/ops/metrics.
4. Validate peer token and protocol compatibility headers.
5. Verify no peer bans accidentally removed all peers.
6. Restart only the app process (do not delete chain files).
7. If stall persists > 30 minutes, fail over to a known-good seed peer set.

Exit criteria:
- two consecutive blocks observed
- nodeLagBlocks returns to 0

## Incident: Peer Poisoning / Eclipse Pressure

1. Inspect abuse-events.jsonl for rate-limit and ops-alert events.
2. Review banned peer identities and banned peer URLs via GET /api/v1/ops/metrics.
3. Validate seed-peer diversity with `npm run mainnet:validate-seeds`.
4. Remove mono-segment peers and add independent provider peers.
5. Keep bans active for the full cooldown window.
6. If divergence is detected, isolate poisoned peers and force resync from trusted peers.

Exit criteria:
- peerHealthy >= 3
- uniqueNetworkSegments >= 3
- no new fork mismatch alerts for 1 hour

## Incident: Bad Release Rollback

1. Stop rollout immediately.
2. Execute upgrade drill rollback procedure (see docs/mainnet-upgrade-governance.md).
3. Restore previous signed installer and update feed metadata.
4. Validate node startup and run:
   - npm run test:p2p-adversarial
   - npm run test:ledger
5. Resume rollout only after all gates pass.

Exit criteria:
- rollback package verified
- health endpoint reports healthy/degraded only
- adversarial and ledger tests pass

## Evidence Capture

For every incident, archive:
- ops-metrics.json snapshot
- abuse-events.jsonl window
- chain tip hash and local height
- peer list and bans
- timeline of actions and operator names
