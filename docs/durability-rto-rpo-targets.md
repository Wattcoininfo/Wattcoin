# Durability, Recovery, And Replay Targets

## Targets

- RTO (restore time objective): <= 15 minutes for single-node restore
- RPO (recovery point objective): <= 1 block for snapshot restore drill
- Deterministic replay: restored state must match baseline state hash and tip hash

## Drill Cadence

- Snapshot/restore drill: daily
- Corruption/replay drill: weekly
- Full cold start replay drill: weekly

## Required Commands

- npm run mainnet:durability:snapshot
- npm run mainnet:durability:corruption

## Evidence Required Per Drill

- start/end timestamps
- measured RTO and RPO
- baseline and restored tip hashes
- pass/fail verdict

## Failure Handling

If any drill fails:
1. freeze release rollout
2. open incident ticket
3. identify root cause and patch
4. re-run failed drill until pass
