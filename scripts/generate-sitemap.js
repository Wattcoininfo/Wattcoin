#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://wattcoin.ee';
const PAGES = [
  { file: 'website/index.html', loc: '/', changefreq: 'weekly', priority: '1.0' },
  {
    file: 'website/wattcoin-whitepaper.html',
    loc: '/wattcoin-whitepaper.html',
    changefreq: 'monthly',
    priority: '0.9',
  },
  { file: 'website/wallet.html', loc: '/wallet.html', changefreq: 'weekly', priority: '0.8' },
  { file: 'website/blog.html', loc: '/blog.html', changefreq: 'weekly', priority: '0.8' },
  {
    file: 'website/blog/proof-of-energy-consensus.html',
    loc: '/blog/proof-of-energy-consensus.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/vortex-initiative.html',
    loc: '/blog/vortex-initiative.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/energy-backed-crypto-vs-bitcoin.html',
    loc: '/blog/energy-backed-crypto-vs-bitcoin.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/mine-cryptocurrency-with-cpu.html',
    loc: '/blog/mine-cryptocurrency-with-cpu.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/mine-cryptocurrency-with-gpu.html',
    loc: '/blog/mine-cryptocurrency-with-gpu.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/enterprise-mining-server-hardware.html',
    loc: '/blog/enterprise-mining-server-hardware.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/asic-mining-wattcoin.html',
    loc: '/blog/asic-mining-wattcoin.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/recovering-contributions-after-reinstall.html',
    loc: '/blog/recovering-contributions-after-reinstall.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  { file: 'website/blog/probe-system.html', loc: '/blog/probe-system.html', changefreq: 'monthly', priority: '0.7' },
  {
    file: 'website/blog/tokenomics-deep-dive.html',
    loc: '/blog/tokenomics-deep-dive.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/fair-for-all-hardware.html',
    loc: '/blog/fair-for-all-hardware.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    file: 'website/blog/cheapest-most-power-hungry-hardware.html',
    loc: '/blog/cheapest-most-power-hungry-hardware.html',
    changefreq: 'monthly',
    priority: '0.7',
  },
];

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLastmod(pageFile) {
  const p = path.join(ROOT, pageFile);
  try {
    const stat = fs.statSync(p);
    return formatDate(stat.mtime);
  } catch {
    return formatDate(new Date());
  }
}

function generate() {
  const urls = PAGES.map((p) => {
    const lastmod = getLastmod(p.file);
    return `  <url>
    <loc>${BASE}${p.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  const outPath = path.join(ROOT, 'website/sitemap.xml');
  fs.writeFileSync(outPath, xml, 'utf8');
  console.log(`✓ sitemap.xml generated (${PAGES.length} URLs, lastmod from file mtime)`);
}

generate();
