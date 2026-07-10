const path = require('path');
const fs = require('fs');

function initQueues({ getWtcNode, saleQueue, stakingQueue, getDataDir }) {
  const wtcNode = getWtcNode();
  if (!wtcNode) return;

  saleQueue.init(getDataDir(), wtcNode);

  try {
    let apiKey = '';
    const apiKeyFile = path.join(getDataDir(), 'sale-api-key.txt');
    if (fs.existsSync(apiKeyFile)) {
      apiKey = fs.readFileSync(apiKeyFile, 'utf8');
      if (apiKey.charCodeAt(0) === 0xfeff) apiKey = apiKey.slice(1);
      apiKey = apiKey.trim();
    }

    saleQueue.setServerApi('https://wattcoin.ee/api', apiKey || null);
    if (apiKey) {
      console.log('[SaleQueue] Server API configured with key (key length:', apiKey.length, ')');
    } else if (fs.existsSync(apiKeyFile)) {
      console.warn('[SaleQueue] sale-api-key.txt exists but is empty - running read-only order sync');
    } else {
      console.log('[SaleQueue] No sale-api-key.txt found - running read-only order sync');
    }
  } catch (e) {
    console.warn('[SaleQueue] Failed to load sale-api-key.txt:', e && e.message);
  }

  stakingQueue.init(getDataDir(), wtcNode);

  try {
    let stakingApiKey = '';
    const stakingKeyFile = path.join(getDataDir(), 'sale-api-key.txt');
    if (fs.existsSync(stakingKeyFile)) {
      stakingApiKey = fs.readFileSync(stakingKeyFile, 'utf8');
      if (stakingApiKey.charCodeAt(0) === 0xfeff) stakingApiKey = stakingApiKey.slice(1);
      stakingApiKey = stakingApiKey.trim();
    }
    if (stakingApiKey) {
      stakingQueue.setWebApi('https://wattcoin.ee/api', stakingApiKey);
    }
  } catch (e) {
    console.warn('[StakingQueue] Failed to configure web API:', e && e.message);
  }
}

module.exports = { initQueues };
