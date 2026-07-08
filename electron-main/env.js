const path = require('path');
const os = require('os');

function getDataDir() {
  return path.join(os.homedir(), 'WattcoinMinerUserData');
}

function getActiveNetwork() {
  return 'wtc-mainnet';
}

module.exports = { getDataDir, getActiveNetwork };
