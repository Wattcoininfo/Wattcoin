#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'website/wattcoin-whitepaper.html');
const ASSETS_DIR = path.join(ROOT, 'assets');

async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  // Make asset paths absolute so they resolve in the PDF
  const patched = html
    .replace(/(src|href)="(assets\/)/g, '$1="file://' + ASSETS_DIR.replace(/\\/g, '/') + '/')
    .replace(/url\(assets\//g, 'url(file://' + ASSETS_DIR.replace(/\\/g, '/') + '/');

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: path.join(ROOT, 'chrome', 'chrome', 'win64-149.0.7827.22', 'chrome-win64', 'chrome.exe'),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.setContent(patched, { waitUntil: 'networkidle0' });

  const pdfPath = path.join(ROOT, 'assets', 'wattcoin-whitepaper.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  });

  await browser.close();
  console.log('PDF generated: ' + pdfPath);
  const stat = fs.statSync(pdfPath);
  console.log('Size: ' + (stat.size / 1024).toFixed(1) + ' KB');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
