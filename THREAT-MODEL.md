# Wattcoin Threat Model

## Trust Boundaries

| Boundary | Enforced by | What it protects |
|----------|------------|-----------------|
| **Renderer ↔ Main Process** | `ipcMain.handle` (Node) | Renderer cannot bypass main-process hardware detection, wallet cache, or contribution clamping |
| **Main Process ↔ Native Binary** | `gpu-miner.exe` (C++), DXGI | GPU adapter/VRAM is read from DXGI, not renderer; native binary cannot be forged from JS |
| **Main Process ↔ Peers** | `/api/v1/*` HTTP routes | Peer contributions require wallet signatures; probe receipts signed by coordinator's secp256k1 key |
| **Proposer ↔ Validators** | `wtc-consensus.js` (BFT) | Every peer independently validates blocks; 2/3 quorum required |

## Assets

- **WTC coins**: Only created by block rewards. Fixed schedule (`rewardForHeight`), hard cap at 21M.
- **Energy contributions**: Clamped server-side, rate-limited, cross-checked against probe attestation.
- **Hardware identity**: HMAC-signed file in userData; trust score tracked across restarts.

## Client-Side (advisory only)

Checks the renderer _could_ bypass but the peer network validates independently:

- **VM detection**: `electron-main.js` uses `systeminformation` + GPU/CPU string matching. Patching the JS disables it, but the peer's probe timing and CPU/GPU proof still reveal low performance → coordinators attest low power.
- **App integrity**: SHA-256 manifest verified at startup. If patched, the manifest hash won't match. Optional ED25519 signature (requires CI private key). Tampering is detected but the app can still run.
- **Anti-debug friction**: Flags `--inspect`, `--remote-debugging-port` in packaged builds. Trivially bypassed with a custom launcher.

## Server-Side (main process enforcement)

Cannot be bypassed by a patched renderer:

- **`walletAddressCache`**: Once set, overrides renderer-supplied addresses in `addContribution`.
- **`maxDeltaWh` clamping**: `calibratedUnitPowerW * trustFactor * loadFactor * 0.5 / 3600` — renderer cannot exceed this regardless of what value it sends.
- **`enforceEndpointRateLimit`**: 1200 calls/min per address for contributions; 10/min for `mine-block`; 30/min for `send`.
- **`hwAuthority.hwHoldUntilMs`**: Locks out contributions for 24h after repeated trust violations.
- **Benchmark history**: Stored with HMAC signature; renderer cannot inject fake benchmarks.
- **`validateContributionProbe`**: Cross-checks every contribution against witnessed probe receipts — requires ≥3 verifier attestations.

## Consensus Layer (peer validation)

Cannot be bypassed by any client, even modified:

- **Block reward**: Fixed per height; peers reject wrong `rewardTotal`.
- **Hard cap**: `supplyBefore + rewardTotal ≤ 21,000,000`.
- **Reward distribution**: Each rewarded address must have witnessed contributions in the round; proportion validated within 10% tolerance.
- **Probe attestation**: Coordinator's secp256k1 signature on probe results — forged by nobody.
- **CPU/Memory/GPU proof**: Independently re-verified by every validating peer.
- **BFT quorum**: 2/3 of network weight required to commit a block.

## Attack Vectors & Mitigations

| Attack | Mitigation | Layer |
|--------|-----------|-------|
| Fake high TDP (5000W) | GPU TDP from native DXGI; CPU capped at 300W; benchmark calibration factor | Server |
| Inject large deltaWh | `maxDeltaWh` clamp; rate limit 1200/min | Server |
| Credit energy to wrong wallet | `walletAddressCache` override | Server |
| Forge probe receipt | secp256k1 signature; verified at block validation | Consensus |
| Skip proof of work | Coordinators send seed, verify hash; peers re-verify | Consensus |
| Create coins from nothing | Fixed reward schedule; 21M cap; peer validation | Consensus |
| Mine in VM | VM detection (advisory); probe timing reveals low perf | Server / Advisory |
| Run modified client | Integrity manifest + ED25519 signature (advisory); server-side clamps work regardless | Advisory / Server |
| 51% attack / collusion | BFT 2/3 quorum; economic game theory | Consensus |
