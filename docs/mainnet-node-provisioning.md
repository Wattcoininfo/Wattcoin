# Mainnet Node Provisioning

This document covers the per-node configuration required to run Wattcoin on mainnet without relying on the shipped defaults.

## Config Layers

Runtime config is resolved in this order, lowest to highest priority:

1. bundled `wattcoin-beta-config.json`
2. local override file at `%USERPROFILE%\WattcoinMinerUserData\wattcoin-local-config.json`
3. environment variables

The local override path is defined in `runtime-config.js` and is intended for per-machine secrets and node-specific topology.

## Auto-Generated On First Launch

On first start, `electron-main.js` generates and stores the following values in the local override file when the shipped defaults are still present:

- `rpcUser`
- `rpcPassword`
- `ledgerNetworkAuthToken`

These are not launch blockers as long as the node has write access to the local override path and startup completes successfully.

## Operator-Supplied Per-Node Values

Operators must still provision and verify the following values per node:

- `ledgerPeers`: peer list for the node's intended seed and steady-state topology
- `ledgerNetworkListenHost`: bind host appropriate for the deployment environment
- `ledgerNetworkListenPort`: port exposure and firewall allowance
- `network`: must remain `wtc-mainnet`
- `autoLaunchNode`: explicit operational choice per role
- any environment-only signing or attestation settings used in the release environment

## Seed And Peer Topology

Bundled seed peers are shipped from `docs/seed-peers.mainnet.json`, but operators should still maintain a per-node plan:

- identify which peers each node should reach first
- maintain provider and region diversity
- avoid placing all canary or validator nodes on one provider or one network segment
- keep an out-of-band recovery peer list for eclipse or poisoning incidents

## Backup And Restore

Back up the following for each node:

- the local override file
- the node data directory
- release artifact version and hash
- seed peer inventory used by that node

Restore procedure:

1. restore the node data directory
2. restore the local override file
3. confirm the node still advertises the expected `networkId`, `protocolVersion`, and `genesisHash`
4. confirm `rpcUser`, `rpcPassword`, and `ledgerNetworkAuthToken` match the restored node identity

If the local override file is lost, the node will regenerate credentials on next launch. Treat that as a credential rotation event and update any dependent automation.

## Token Rotation

Rotate the ledger token whenever:

- a node image is cloned
- a node is rebuilt from scratch
- logs or backups may have exposed the token
- an operator with prior access leaves the rotation boundary

Rotation procedure:

1. stop the node or isolate it from peers
2. replace `ledgerNetworkAuthToken` in the local override file
3. update any trusted peer configuration that depends on the token
4. restart the node
5. verify authenticated requests to `/api/v1/ops/health` and `/api/v1/ops/metrics`
6. verify the node rejoins and `nodeLagBlocks` returns to `0`

## Deployment Credentials

Do not store deployment usernames, passwords, or API keys in tracked files.

For the local deploy helpers in `scripts/`, provide secrets through environment variables:

- `WATTCOIN_DEPLOY_HOST`
- `WATTCOIN_DEPLOY_PORT`
- `WATTCOIN_DEPLOY_USER`
- `WATTCOIN_DEPLOY_PASSWORD`

Rotate any previously embedded deployment credential immediately.