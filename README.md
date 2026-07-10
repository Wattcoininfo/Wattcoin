# Wattcoin Miner

<p>
  <a href="https://github.com/Wattcoininfo/Wattcoin/actions"><img src="https://img.shields.io/github/actions/workflow/status/Wattcoininfo/Wattcoin/ci.yml?branch=master&label=CI&logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Wattcoininfo/Wattcoin?color=blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js" alt="Node">
  <a href="https://github.com/Wattcoininfo/Wattcoin/releases"><img src="https://img.shields.io/github/v/release/Wattcoininfo/Wattcoin?include_prereleases&label=release" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Platform">
</p>

**Proof-of-Energy cryptocurrency miner** — a desktop application for mining WTC, the energy-backed cryptocurrency.

Wattcoin's Proof-of-Energy (PoE) consensus replaces wasteful hash-based mining with **verifiable electrical energy consumption**. Miners are rewarded proportionally to the energy they contribute, creating a direct physical link between computational work and token value.

---

## Features

- **Proof-of-Energy Mining** — Mine WTC by contributing verifiable CPU/GPU energy with hardware probe attestation
- **Built-in Wallet** — Native WTC address support with encrypted key storage
- **Staking** — Stake WTC to earn staking rewards
- **Governance** — On-chain proposal and voting (PIPs) with stake-weighted votes
- **Vortex NFT Collection** — 60 NFT collection with profit-sharing mechanics
- **Built-in Sale Queue** — Buy WTC directly from the sale contract
- **Peer-to-Peer Network** — Decentralized consensus via BFT voting with transaction mempool
- **Auto-Update** — Automatic installer updates via `electron-updater`
- **Monitoring Stack** — Prometheus/Grafana monitoring for node operators

---

## System Requirements

- **OS:** Windows 10 / 11 (x64), Linux (x64), macOS (ARM64 / x64)
- **Network:** Internet connection (port 39310 for peer discovery)
- **Storage:** ~200 MB for the application

---

## Installation

**Windows** — Download the latest installer from [wattcoin.ee](https://wattcoin.ee) and run `Wattcoin Miner Setup X.X.X.exe`. The installer will:

1. Install the application to your chosen directory
2. Add a Windows Firewall rule for peer-to-peer communication (port 39310)
3. Create Start Menu and Desktop shortcuts
4. Launch the miner on completion

**Linux** — Download the `.AppImage` or `.deb` from [wattcoin.ee](https://wattcoin.ee). Make the AppImage executable (`chmod +x`) and run it, or install the `.deb` with `dpkg -i`.

**macOS** — Download the `.dmg` from [wattcoin.ee](https://wattcoin.ee), mount it, and drag Wattcoin Miner to Applications. The app is unsigned by default — right-click → Open on first launch.

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

Build the renderer first, then package with electron-builder for your platform:

```bash
# 1. Build the Vite frontend
npm run build

# 2. Package platform-specific installer
npx electron-builder --win    # Windows NSIS installer (.exe)
npx electron-builder --linux  # Linux AppImage + .deb
npx electron-builder --mac    # macOS DMG + ZIP
```

**Artifacts:**

| Platform | Output |
|----------|--------|
| Windows  | `Releases/Wattcoin Miner Setup X.X.X.exe` |
| Linux    | `Releases/Wattcoin-Miner-X.X.X.AppImage` + `.deb` |
| macOS    | `Releases/Wattcoin-Miner-X.X.X.dmg` + `.zip` |

**Local full build (Vite + electron-builder for current platform):**

```bash
npm run electron:build:local
```

**Production release (version bump + build + SFTP deploy):**

```bash
npm run electron:build
```

> **macOS code signing:** Omitted by default — the DMG/ZIP will be unsigned. Users can right-click → Open on first launch. To sign, set `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables to your Apple Developer certificate.

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
├── miner.html                    # Desktop miner app entry (Vite)
│
├── frontend/                     # React UI components
│   ├── main.jsx                  # React entry point
│   ├── AppTabs.jsx               # Tab-based application shell
│   ├── Miner.jsx                 # Mining UI component
│   ├── Wattcoin.jsx              # Buy/stake/wallet UI
│   ├── Governance.jsx            # Governance UI component
│   ├── MiningLog.jsx             # Mining log viewer
│   ├── wattcoin/                 # Wattcoin.jsx sub-components
│   └── governance/               # Governance.jsx sub-components
│
├── website/                      # Website content (deployed to wattcoin.ee)
│   ├── index.html                # Website homepage
│   ├── wattcoin-whitepaper.html  # Whitepaper page
│   ├── wallet.html               # Web wallet page
│   ├── blog.html                 # Blog listing page
│   ├── blog/                     # Individual blog post pages
│   ├── sitemap.xml               # SEO sitemap
│   ├── robots.txt                # Robots exclusion rules
│   ├── site.webmanifest          # Web app manifest
│   └── htdocs.htaccess           # Apache config (deployed as .htaccess)
│
├── electron-main.js              # Electron main process entry
├── electron-start.js             # Electron startup script
├── preload.js                    # IPC preload bridge with channel allowlist
├── electron-builder.config.js    # Electron-builder configuration
├── vite.config.mjs               # Vite build configuration
│
├── electron-main/                # Backend modules (main process)
│   ├── wtc-node.js               # WTC blockchain node (orchestrator)
│   ├── wtc-chain.js              # Block/chain data structures
│   ├── wtc-consensus.js          # BFT consensus (propose, vote, commit)
│   ├── wtc-accounts.js           # Account state (balances, nonces, maturity)
│   ├── wtc-address.js            # Address derivation, signing, verification
│   ├── wtc-mempool.js            # Transaction mempool
│   ├── wtc-staking-queue.js      # Staking logic
│   ├── wtc-sale-queue.js         # Sale order queue
│   ├── wtc-nfts.js               # NFT store
│   ├── wtc-governance.js         # Governance logic
│   ├── probe-attestation.js      # Hardware probe attestation
│   ├── protocol-constants.js     # Network protocol constants
│   ├── peer-privacy.js           # Peer privacy & relay
│   ├── peer-self-filter.js       # Self-connection filter
│   ├── peer-discovery-observability.js
│   ├── peer-count-observability.js
│   ├── remote-seed-manifest.js   # Remote seed peer manifest
│   ├── requester-registration.js # Requester registration
│   ├── local-subnet-discovery.js # LAN peer discovery
│   ├── round-ledger.js           # Round event ledger
│   ├── runtime-config.js         # Configuration loader
│   ├── hardware-load-controller.js # CPU + DDR load controller
│   ├── gpu-load-controller.js    # Native GPU load controller (gpu-miner.exe)
│   ├── cpu-load-worker.js        # CPU load simulation worker
│   ├── ddr-load-worker.js        # RAM load simulation worker
│   ├── hardware-tables.cjs       # Hardware energy tables
│   ├── ops-health.js             # Operational health checks
│   ├── backend-benchmark.js      # Backend benchmarking
│   └── ...                       # IPC handlers, peer networking, wallet, etc.
│
├── native-gpu/                   # Native GPU miner binary (C++)
│   ├── src/
│   │   ├── main.cpp              # Multi-DirectX backend, stdin/stdout JSON IPC
│   │   ├── compute.hlsl          # GPU compute shader (float vector math)
│   │   └── proof.hlsl            # GPU proof shader (integer XOR-shift)
│   └── build.ps1                 # Build script (Visual Studio)
│
├── server/                     # PHP microservices for wattcoin.ee
│   ├── api/                    # Token sale API
│   │   ├── index.php
│   │   └── .htaccess
│   ├── counter/                # Visit/download counter API
│   │   ├── index.php
│   │   └── .htaccess
│   ├── elec-price/             # Electricity price API
│   │   ├── index.php
│   │   └── .htaccess
│   └── seed-registry/          # Seed registry proxy
│       └── seed-registry-proxy.php
│
├── scripts/
│   ├── release-build.js          # Build + deploy orchestrator
│   ├── _sftp-deploy.js           # SFTP deployment (primary)
│   ├── deploy-files.js           # SFTP deployment (static files only)
│   ├── deploy-seed-manifest.js   # Seed manifest deploy
│   └── ...
├── assets/
│   ├── whitepaper.css            # Whitepaper page styles
│   ├── new_icon.png
│   └── Vortex NFT *.jpg          # NFT collection images
├── docs/                         # Operations documentation
├── monitoring/                   # Prometheus/Grafana monitoring stack
├── tests/                        # Test files (36 test suites)
└── releases/                     # Built installers
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    Website (wattcoin.ee)                          │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐  │
│  │ Static Pages     │  │ PHP APIs                             │  │
│  │  - index.html    │  │  - counter/      (visits/downloads) │  │
│  │  - wallet.html   │  │  - elec-price/   (electricity cost) │  │
│  │  - miner.html    │  │  - api/          (token sale)      │  │
│  │  - whitepaper    │  └──────────────────────────────────────┘  │
│  │  - blog.html     │  ┌──────────────────────────────────────┐  │
│  │  - sitemap.xml   │  │ Apache (.htaccess)                   │  │
│  │  - robots.txt    │  │  caching, gzip, CSP, redirects      │  │
│  │  - updates.xml   │  └──────────────────────────────────────┘  │
│  └──────────────────┘                                            │
└──────────────────────────────┬───────────────────────────────────┘
                                │  HTTPS / Releases
┌──────────────────────────────┴───────────────────────────────────┐
│                  Electron Desktop App                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Renderer Process                                           │  │
│  │  (Miner.jsx, AppTabs.jsx, Wattcoin.jsx, Governance.jsx)     │  │
│  │         ↕ IPC (preload.js allowlist)                        │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Main Process (electron-main.js)                            │  │
│  │  ┌──────────┬───────────┬──────────┬──────────────────┐    │  │
│  │  │ Network  │ Attest.   │ Wallet   │ HW Load Ctrl     │    │  │
│  │  │ Server   │ Engine    │ Manager  │ (CPU/DDR/GPU)    │    │  │
│  │  ├──────────┴───────────┴──────────┴──────────────────┤    │  │
│  │  │                WTC Node (wtc-node.js)               │    │  │
│  │  │  ┌──────────┬──────────┬──────────────────────┐    │    │  │
│  │  │  │ Chain    │ Consensus│ Mempool / Accounts   │    │    │  │
│  │  │  │ (blocks) │ (BFT)    │ (state)              │    │    │  │
│  │  │  ├──────────┼──────────┼──────────────────────┤    │    │  │
│  │  │  │ Staking  │ NFTs     │ Sale Queue           │    │    │  │
│  │  │  └──────────┴──────────┴──────────────────────┘    │    │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  │           ↕                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  Native GPU Miner (gpu-miner.exe, Windows)                │  │  │
│  │  │  gpu-load-controller.js → DirectX compute/pixel shaders │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                             ↕                                     │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Build & Deploy Pipeline                                   │  │
│  │  release-build.js → electron-builder → deploy-files.js    │  │
│  │  Version bump → Vite build → electron-builder → SFTP      │  │
│  │  deploy-files.js → SFTP static files (HTML, API, assets)  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Security

See [SECURITY.md](docs/SECURITY.md) for the full security policy and vulnerability reporting process.

- **Attestation:** Hardware identity is HMAC-SHA256 signed with an encrypted device secret (DPAPI on Windows)
- **Wallet Encryption:** AES-256-GCM encrypted with key derived from device identity
- **IPC Security:** Preload script uses an explicit channel allowlist; unlisted channels are rejected
- **Rate Limiting:** Sensitive IPC handlers (mining, sends, contributions) are rate-limited
- **CSP:** Strict Content-Security-Policy in production (no external resources)
- **Electron Fuses:** ASAR integrity validation, cookie encryption, disabled Node CLI inspect
- **Integrity Manifest:** SHA-256 hashes of all main-process JS files verified at runtime
- **Binary Signing:** All bundled Windows executables and DLLs are Authenticode-signed (dev cert supported)

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines on code style, testing, and pull requests.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Links

- **Website:** [https://wattcoin.ee](https://wattcoin.ee)
- **Whitepaper:** [https://wattcoin.ee/wattcoin-whitepaper.html](https://wattcoin.ee/wattcoin-whitepaper.html)
- **GitHub:** [https://github.com/Wattcoininfo/Wattcoin](https://github.com/Wattcoininfo/Wattcoin)
