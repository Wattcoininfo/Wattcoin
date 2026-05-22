# Mainnet Peer Discovery

Wattcoin mainnet does not rely on a privileged master node. Instead it uses seed peers and peer discovery, where every reachable peer is just an introduction source and never a source of truth by itself.

## Discovery Sources

The client builds its candidate peer set from four sources:

1. `ledgerPeers` from local runtime config.
2. Bundled seed peers from `docs/seed-peers.mainnet.json` packaged with the app.
3. LAN multicast beacons on UDP `39311` for same-subnet discovery.
4. Peer exchange and the discovered-peer cache.

Mainnet clients can optionally refresh a remote seed manifest over HTTPS and merge the last successful remote seed list into the bundled seed set. This is disabled by default and only activates when `ledgerSeedManifestUrls` or `WATTCOIN_LEDGER_SEED_MANIFEST_URLS` is explicitly configured.

Bundled seed peers are only first-contact hints. They are not authoritative and are used as bootstrap and peer-directory targets rather than as the default static sync peer set.

Current repo configuration ships both the bundled seed and the default configured ledger peer at `http://62.65.200.145:39310`, so the public seed box is also the shipped steady-state ledger entry point.

## Exact Flow

1. On startup, the app loads configured peers, bundled seed peers, and any cached remote seed manifest only when a remote manifest URL has been explicitly configured.
2. It restores recently seen discovered peers from `userData/seed-peer-cache.json`.
3. If peer mode is enabled, it starts the HTTP peer server on port `39310` and the LAN discovery beacon listener on UDP `39311`.
4. The app sends a multicast beacon so nearby nodes can learn its address.
5. If a remote seed manifest URL has been explicitly configured, the app refreshes it in the background, then queries a small random sample of configured peers, bundled seed peers, remote manifest peers, and already discovered peers using `GET /api/v1/network/peers`.
6. Any peer list returned by those nodes is merged into the discovered-peer set.
7. The discovered-peer set is cached locally and reused on restart.
8. Sync and consensus then validate candidates through `chain/tip`, `chain/headers`, `chain/blocks`, votes, and fork checks.

## Why No Host Is Special

- A bundled seed can disappear and the network still works if any other reachable peer remains.
- A peer learned through LAN beacon or peer exchange is treated the same as one from the bundled seed list.
- The cache lets a node reconnect using previously discovered peers even if bundled seeds are unavailable.
- A bad peer can only advertise candidates; it cannot redefine the chain because normal chain compatibility and sequence validation still apply.

## Endpoint

Peer exchange uses:

- `GET /api/v1/network/peers`

This returns a peer's current view of configured peers, bundled seed peers, and recently discovered peers. It is an address-sharing endpoint, not a trust endpoint.

## Production Expectations

Before launch, operators should still:

1. ship more than one bundled seed peer
2. keep provider and network-segment diversity
3. maintain per-node `ledgerPeers` for known good entry points
4. verify peer exchange produces overlap between independent nodes
5. confirm a fresh node can join when one or more seed peers are offline
6. if you opt into a remote seed manifest, keep it reachable over HTTPS and update it whenever the intended seed topology changes