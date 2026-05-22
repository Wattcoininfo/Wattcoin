# Mainnet Monitoring And Alerting Deployment

The application exposes the data needed for operations, but mainnet requires an external monitoring system that polls, stores, and alerts on that data.

## Required Data Sources

Poll each mainnet node for:

- `GET /api/v1/ops/health`
- `GET /api/v1/ops/metrics`

Collect local files from each node on a retention schedule:

- `userData/ops-metrics.json`
- `userData/abuse-events.jsonl`

## Minimum Polling Plan

- `ops/health`: every 30 seconds
- `ops/metrics`: every 60 seconds
- `ops-metrics.json`: archive every 5 minutes
- `abuse-events.jsonl`: ship continuously or rotate every 5 minutes

## Required Alerts

Implement the thresholds documented in `docs/mainnet-ops-runbook.md`:

- `chain.stall`: `latestBlockAgeMs >= 20 minutes`
- `peer.diversity.low`: unique network segments below `3` while `peerTotal >= 3`
- `mempool.pressure.high`: pressure `>= 0.85`
- rollback warning: rollback depth `>= 3`
- critical fork pressure: `forkRatePerHour > 3` for `15 minutes`

Also page on:

- health status `critical`
- `nodeLagBlocks > 0` for more than 10 minutes on a steady-state node
- authenticated endpoint failures caused by missing or invalid ledger token
- no fresh scrape data from a node for more than 2 polling intervals

## Alert Routing

Mainnet is not production-ready until the alerts route somewhere real.

At minimum configure:

- one paging target for critical alerts
- one non-paging target for warnings and daily summaries
- an incident owner rotation or named on-call operator
- a retained incident timeline for postmortems

The specific platform can be Prometheus and Alertmanager, Grafana Cloud, PagerDuty, Opsgenie, or another equivalent system. This repo does not currently include that stack.

## Retention

Minimum recommended retention:

- scrape history: 30 days
- `ops-metrics.json` archives: 30 days
- `abuse-events.jsonl`: 30 days hot, 90 days cold
- release rollout evidence and upgrade drill artifacts: keep for each release

## Dashboards

Expose these fields per node and fleet-wide:

- `forkRatePerHour`
- `rollbackMedianDepth`
- `peerHealthy`
- `peerTotal`
- `mempoolPressure`
- `blockIntervalMedianSec`
- `nodeLagBlocks`
- health status
- scrape freshness

## Operational Readiness Checklist

Before mainnet launch:

1. verify all nodes scrape successfully using the real ledger token path
2. trigger one warning-class alert and one critical-class alert in staging
3. verify alert delivery and acknowledgement path
4. verify retention and log shipping work across restart
5. verify incident operators can retrieve `ops-metrics.json` and `abuse-events.jsonl` for a chosen time window

If any of those are missing, monitoring is still documentation-only rather than deployed operations.