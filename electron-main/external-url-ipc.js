const http = require('http');
const fs = require('fs');
const path = require('path');

function registerExternalUrlIpcHandlers(ipcMain, { shell }) {
  const ALLOWED_EXTERNAL_ORIGINS = new Set([]);
  const ALLOWED_EIP681_CONTRACTS = new Set(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']);

  const _payPageTemplate = fs.readFileSync(path.join(__dirname, 'pay-page.html'), 'utf8');

  ipcMain.handle('wattcoin-open-external-url', (_event, url) => {
    try {
      if (typeof url !== 'string') return { ok: false, reason: 'not a string' };
      const parsed = new URL(url);
      if (parsed.protocol === 'ethereum:') {
        const contractAddr = parsed.pathname.split('@')[0].toLowerCase();
        if (!ALLOWED_EIP681_CONTRACTS.has(contractAddr)) return { ok: false, reason: 'unknown contract' };
        shell.openExternal(url);
        return { ok: true };
      }
      if (parsed.protocol !== 'https:') return { ok: false, reason: 'only https or ethereum allowed' };
      if (!ALLOWED_EXTERNAL_ORIGINS.has(parsed.hostname)) return { ok: false, reason: 'hostname not in allowlist' };
      const safe = `https://${parsed.hostname}${parsed.pathname}`;
      shell.openExternal(safe);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'invalid url' };
    }
  });

  ipcMain.handle('wattcoin-open-pay-page', (_event, { usdcRequired, wtcAmount, sellerAddress }) => {
    try {
      if (typeof usdcRequired !== 'number' || typeof sellerAddress !== 'string') {
        return { ok: false, reason: 'invalid params' };
      }
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const safeAddr = sellerAddress.replace(/[^0-9a-fA-Fx]/g, '').toLowerCase();
      const amountUnits = Math.round(usdcRequired * 1_000_000);
      const eip681 = `ethereum:${USDC_CONTRACT}@1/transfer?address=${safeAddr}&uint256=${amountUnits}`;

      const html = _payPageTemplate
        .replace('{{USDC_REQUIRED}}', usdcRequired.toFixed(2))
        .replace('{{WTC_AMOUNT_LOCALE}}', Number(wtcAmount).toLocaleString())
        .replace('{{SAFE_ADDR}}', safeAddr)
        .replace('{{USDC_CONTRACT}}', USDC_CONTRACT)
        .replace('{{USDC_REQUIRED_RAW}}', String(usdcRequired))
        .replace('{{EIP681}}', eip681);

      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        setTimeout(() => {
          try {
            server.close();
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
          }
        }, 3000);
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        shell.openExternal(`http://127.0.0.1:${port}/`);
      });
      server.on('error', () => {});
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message) };
    }
  });
}

module.exports = { registerExternalUrlIpcHandlers };
