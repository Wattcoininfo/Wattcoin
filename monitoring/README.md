# Wattcoin Mainnet Monitoring Stack

This directory adds the monitoring and alerting stack that the mainnet docs require but the app repo previously lacked.

## What It Deploys

- `collector`: polls `GET /api/v1/ops/health` every 30 seconds and `GET /api/v1/ops/metrics` every 60 seconds using the real ledger token header, exports Prometheus metrics on port `9464`, archives snapshots, and writes an incident timeline JSONL.
- `prometheus`: scrapes the collector every 30 seconds and evaluates the mainnet alert thresholds.
- `alertmanager`: routes critical alerts to the paging webhook and warnings to the non-paging webhook.
- `loki` + `promtail`: retain incident timeline events and archived `abuse-events.jsonl` files for investigation.
- `grafana`: pre-provisioned datasources and a dashboard for fleet health, lag, peer diversity, fork pressure, mempool pressure, and incident history.

## Files Collected And Retention

- HTTP snapshot archive: `monitoring/data/archive/<node>/ops-metrics/*.json`
- Remote node `ops-metrics.json`: `monitoring/data/archive/<node>/ops-metrics-remote/*.json`
- Remote node `abuse-events.jsonl`: `monitoring/data/archive/<node>/abuse-events/*.jsonl`
- Cold-compressed abuse log archive after 30 days: `monitoring/data/cold/<node>/abuse-events/*.jsonl.gz`
- Incident timeline: `monitoring/data/incidents/incident-timeline.jsonl`

Retention policy implemented by the collector:

- scrape and snapshot archives: 30 days
- abuse log hot archive: 30 days
- abuse log cold archive: 90 days total

## Configure

1. Copy `monitoring/.env.example` to `monitoring/.env`.
2. Set real webhook endpoints for paging and warning delivery.
3. Copy `monitoring/nodes.example.json` to `monitoring/nodes.json`.
4. For each node, fill in:
   - `opsBaseUrl`
   - `ledgerTokenEnv`
   - SSH host, username, and remote `userData` directory
5. Put each referenced token and SSH password in `monitoring/.env`.

For the default SSH tunnel layout in `monitoring/nodes.example.json`:

- leave `opsBaseUrl` pointed at `http://127.0.0.1:39310`
- set `ssh.host` to the reachable server hostname or IP
- set `ssh.privateKeyPath` to a key file under `monitoring/keys/`
- keep `ssh.tunnel.targetHost` as `127.0.0.1` unless the node listens on another private interface

That lets the collector poll the private ops endpoints over SSH without exposing port `39310` publicly.

The collector expects the node files to live under the configured `remoteUserDataDir`:

- `ops-metrics.json`
- `abuse-events.jsonl`

If you prefer password auth, replace `privateKeyPath` with `passwordEnv` in `monitoring/nodes.json`.

When using SSH keys with Docker Compose, place them under `monitoring/keys/`. The compose file mounts that directory into the collector container at `/config/keys`.

If you use the SSH tunnel mode, the monitoring host does not need direct inbound access to each node's port `39310`. It still needs:

- outbound SSH access to each node on its SSH port
- permission for the SSH user to read the node `userData` directory
- outbound access from the node itself to its own local ops listener, typically `127.0.0.1:39310`

## Deploy

From the repo root:

```powershell
docker compose -f monitoring/docker-compose.yml up -d --build
```

Endpoints after startup:

- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Alertmanager: `http://localhost:9093`
- Collector metrics: `http://localhost:9464/metrics`

## Validation

Run these checks after deployment:

1. `docker compose -f monitoring/docker-compose.yml ps`
2. Open Prometheus and confirm `wattcoin_node_up == 1` for every node.
3. Open Grafana and verify the `Wattcoin Mainnet` dashboard loads.
4. Confirm `monitoring/data/incidents/incident-timeline.jsonl` receives entries when you force a bad token or stop a node.
5. Confirm archived copies of `ops-metrics.json` and `abuse-events.jsonl` appear under `monitoring/data/archive`.

If `wattcoin_node_up` stays `0` while SSH archiving succeeds, the usual cause is a bad `ssh.tunnel.targetHost` or `targetPort` rather than a public firewall rule.

## Alert Coverage

The bundled alert rules implement the thresholds from `docs/mainnet-monitoring.md` and `docs/mainnet-ops-runbook.md`:

- chain stall
- peer diversity low
- mempool pressure high
- rollback depth warning
- critical fork pressure
- health status critical
- node lag persisting for 10 minutes
- authenticated endpoint failures
- no fresh scrape data for more than two polling intervals

## Operational Notes

- The collector uses the same `x-wattcoin-ledger-token` header that the app expects on `/api/v1/ops/health` and `/api/v1/ops/metrics`.
- The incident timeline is append-only JSONL so postmortem tooling can replay exact alert transitions.
- Alertmanager webhook receivers are placeholders until you set real production endpoints in `monitoring/.env`.