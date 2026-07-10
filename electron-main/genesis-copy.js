const path = require('path');
const fs = require('fs');

function ensureCanonicalGenesis({ getWalletDataDir }) {
  try {
    const genesisDestPath = path.join(getWalletDataDir(), 'wtc-genesis.json');
    const genesisSourcePath = [
      process.resourcesPath ? path.join(process.resourcesPath, 'wtc-genesis.json') : '',
      path.join(__dirname, 'resources', 'wtc-genesis.json'),
      path.join(__dirname, '..', 'resources', 'wtc-genesis.json'),
    ].find((candidate) => candidate && fs.existsSync(candidate));
    if (genesisSourcePath && fs.existsSync(genesisSourcePath)) {
      fs.mkdirSync(path.dirname(genesisDestPath), { recursive: true });
      fs.copyFileSync(genesisSourcePath, genesisDestPath);
      console.log('[WtcNode] Canonical wtc-genesis.json copied to userData.');
    } else {
      console.warn('[WtcNode] Bundled wtc-genesis.json not found -- genesis will fall back to local address.');
    }
  } catch (genesisErr) {
    console.warn('[WtcNode] Could not install wtc-genesis.json:', genesisErr && genesisErr.message);
  }
}

module.exports = { ensureCanonicalGenesis };
