# Wattcoin Miner

**Proof-of-Energy cryptocurrency miner** — a desktop application for mining WTC, the energy-backed cryptocurrency.

Wattcoin's Proof-of-Energy (PoE) consensus replaces wasteful hash-based mining with **verifiable electrical energy consumption**. Miners are rewarded proportionally to the energy they contribute, creating a direct physical link between computational work and token value.

---

## Features

- **Proof-of-Energy Mining** — Mine WTC by contributing verifiable CPU/GPU energy
- **Built-in Wallet** — Native WTC address support with encrypted key storage
- **Staking** — Stake WTC to earn staking rewards
- **Vortex NFT Collection** — 60 NFT collection with profit-sharing mechanics
- **Built-in Sale Queue** — Buy WTC directly from the sale contract
- **Peer-to-Peer Network** — Decentralized consensus via BFT voting
- **Auto-Update** — Automatic installer updates via `electron-updater`
- **Monitoring Stack** — Prometheus/Grafana monitoring for node operators

---

## System Requirements

- **OS:** Windows 10 / 11 (x64)
- **Network:** Internet connection (port 39310 for peer discovery)
- **Storage:** ~200 MB for the application

---

## Installation

Download the latest installer from [wattcoin.ee](https://wattcoin.ee) and run `Wattcoin Miner Setup X.X.X.exe`.

The installer will:
1. Install the application to your chosen directory
2. Add a Windows Firewall rule for peer-to-peer communication (port 39310)
3. Create Start Menu and Desktop shortcuts
4. Launch the miner on completion

---

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
npm install
npm run electron:dev
```

This starts the Vite dev server and launches Electron with hot-reload.

### Build Installer

```bash
# Full build + deploy to wattcoin.ee (requires SFTP credentials)
npm run electron:build

# Local build only (no upload — no credentials needed)
npm run electron:build:local
```

The build script:
1. Bumps the patch version
2. Builds the Vite frontend
3. Runs electron-builder to produce an NSIS installer
4. Signs the installer (if a dev certificate is present in `certs/`)
5. Uploads to `wattcoin.ee` via SFTP (requires credentials) — skipped with `--local`
6. Verifies deployed assets are reachable — skipped with `--local`

### Lint

```bash
npm run lint        # Check for lint violations
npm run lint:fix    # Auto-fix lint violations
npm run format      # Format code with Prettier
```

### Test

```bash
npm test            # Run all tests with Vitest
npm run test:ui     # Run tests with Vitest UI
npm run coverage    # Run tests with coverage report
```

Individual test suites:

```bash
npm run test:ledger                 # Ledger integration tests
npm run test:staking                # Staking queue tests
npm run test:p2p-adversarial        # Adversarial P2P network tests
npm run test:chain-corruption       # Chain corruption tests
npm run test:counterfeit            # Counterfeit/spoofing security tests
# ... see package.json for the full list
```

---

## Project Structure

```
├── electron-main.js          # Electron main process (RPC, networking, attestation)
├── preload.js                # IPC preload bridge with channel allowlist
├── wtc-node.js               # WTC blockchain node
├── wtc-chain.js              # Block/chain data structures
├── wtc-consensus.js          # BFT consensus (propose, vote, commit)
├── wtc-accounts.js           # Account state (balances, nonces, maturity)
├── wtc-address.js            # Address derivation, signing, verification
├── wtc-mempool.js            # Transaction mempool
├── wtc-staking-queue.js      # Staking logic
├── wtc-sale-queue.js         # Sale order queue
├── wtc-nfts.js               # NFT store
├── probe-attestation.js      # Hardware probe attestation
├── runtime-config.js          # Configuration loader
├── Miner.jsx                 # Main mining UI component
├── AppTabs.jsx               # Tab-based application shell
├── Wattcoin.jsx              # Buy/stake/wallet UI
├── MiningLog.jsx             # Mining log viewer
├── scripts/
│   ├── release-build.js      # Build + deploy orchestrator
│   ├── _sftp-deploy.js       # SFTP deployment
│   └── ...
├── tests/                    # Test files (30 test suites)
├── docs/                     # Operations documentation
└── monitoring/               # Prometheus/Grafana monitoring stack
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                  Electron Renderer                 │
│  (Miner.jsx, AppTabs.jsx, Wattcoin.jsx)           │
│         ↕ IPC (preload.js allowlist)              │
├──────────────────────────────────────────────────┤
│               Electron Main Process               │
│  (electron-main.js)                               │
│  ┌──────────┬───────────┬──────────┬───────────┐  │
│  │ Network  │ Attest.   │ Wallet   │ Updates   │  │
│  │ Server   │ Engine    │ Manager  │ & Config  │  │
│  ├──────────┴───────────┴──────────┴───────────┤  │
│  │            WTC Node (wtc-node.js)            │  │
│  │  ┌──────────┬──────────┬──────────────────┐  │  │
│  │  │ Chain    │ Consensus│ Mempool/Accounts │  │  │
│  │  │ (blocks) │ (BFT)    │ (state)          │  │  │
│  │  └──────────┴──────────┴──────────────────┘  │  │
│  │  ┌──────────┬──────────┬──────────────────┐  │  │
│  │  │ Staking  │ NFTs     │ Sale Queue       │  │  │
│  │  └──────────┴──────────┴──────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Security

- **Attestation:** Hardware identity is HMAC-SHA256 signed with an encrypted device secret (DPAPI on Windows)
- **Wallet Encryption:** AES-256-GCM encrypted with key derived from device identity
- **IPC Security:** Preload script uses an explicit channel allowlist; unlisted channels are rejected
- **Rate Limiting:** Sensitive IPC handlers (mining, sends, contributions) are rate-limited
- **CSP:** Strict Content-Security-Policy in production (no external resources)
- **Electron Fuses:** ASAR integrity validation, cookie encryption, disabled Node CLI inspect
- **Integrity Manifest:** SHA-256 hashes of all main-process JS files verified at runtime
- **Binary Signing:** All bundled executables and DLLs are Authenticode-signed (dev cert supported)

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Links

- **Website:** [https://wattcoin.ee](https://wattcoin.ee)
- **Whitepaper:** [https://wattcoin.ee](https://wattcoin.ee)

