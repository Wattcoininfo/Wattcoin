#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BLOG_FILE = path.join(ROOT, 'website/blog.html');

const BLOG_SRC = fs.readFileSync(BLOG_FILE, 'utf8');
const BASE_URL = 'https://wattcoin.ee';

// ── Post definitions extracted from the articles in blog.html ──
// Each entry: { id, file, title, desc, date, tags, anchorId }
const POSTS = [
  {
    id: 'proof-of-energy-consensus',
    title: 'What Is Proof-of-Energy Consensus?',
    desc: 'A complete guide to Proof-of-Energy consensus — how it replaces hash-based mining with verifiable energy expenditure, the tier ratchet, and proportional block rewards.',
    date: 'May 31, 2026',
  },
  {
    id: 'vortex-initiative',
    title: 'What Is the Vortex Initiative?',
    desc: 'The 60 kW Vortex Gravity Hydro Turbine in Estonia — how real physical infrastructure backs the Wattcoin network with verifiable on-chain electricity revenue.',
    date: 'May 31, 2026',
  },
  {
    id: 'energy-backed-crypto-vs-bitcoin',
    title: 'Energy-Backed Crypto vs Bitcoin — A Fair Comparison',
    desc: 'How Wattcoin Proof-of-Energy compares to Bitcoin Proof-of-Work on energy efficiency, hardware fairness, value floor, and e-waste.',
    date: 'May 31, 2026',
  },
  {
    id: 'mine-cryptocurrency-with-cpu',
    title: 'How to Mine Cryptocurrency with CPU — Wattcoin Guide',
    desc: 'Step-by-step guide to mining WTC with any CPU. No ASICs, no pools, no luck variance — just fair energy-based mining on Wattcoin.',
    date: 'May 31, 2026',
    schemaType: 'HowTo',
    howToSteps: [
      'Download the Wattcoin Miner',
      'Install and Launch',
      'Wallet Auto-Generation',
      'Click Start Mining',
      'Earn Every Block',
      'Stake or Hold',
    ],
  },
  {
    id: 'mine-cryptocurrency-with-gpu',
    title: 'How to Mine Cryptocurrency with GPU — Wattcoin Guide',
    desc: 'Step-by-step guide to mining WTC with any GPU. DirectX compute shader workloads, multi-GPU rigs, and efficiency tips for Proof-of-Energy mining.',
    date: 'May 31, 2026',
    schemaType: 'HowTo',
    howToSteps: [
      'Download the Wattcoin Miner',
      'GPUs Detected Automatically',
      'Set Load and Start',
      'Earn Every Block',
      'Combine with CPU',
    ],
  },
  {
    id: 'enterprise-mining-server-hardware',
    title: 'Enterprise Mining — Server Hardware on Wattcoin',
    desc: 'Deploying server CPUs and rack infrastructure for maximum energy contribution on the Wattcoin Proof-of-Energy network.',
    date: 'May 31, 2026',
    schemaType: 'HowTo',
    howToSteps: [
      'Install the Miner on Each Node',
      'Configure CPU Workloads',
      'Set Duty Cycle',
      'Point to Your Wallet',
      'Monitor and Scale',
    ],
  },
  {
    id: 'asic-mining-wattcoin',
    title: 'ASIC Mining and Wattcoin — How ASICs Work on PoE',
    desc: 'How ASICs work with Proof-of-Energy — model-specific power lookup, no hash-rate obsolescence, and why the ASIC era is over.',
    date: 'May 31, 2026',
  },
  {
    id: 'recovering-contributions-after-reinstall',
    title: 'Recovering Contributions After Reinstall',
    desc: 'How peer-to-peer contribution recovery ensures you never lose mid-round mining progress after reinstalling the Wattcoin Miner app.',
    date: 'June 5, 2026',
  },
  {
    id: 'tokenomics-deep-dive',
    title: 'Wattcoin Tokenomics Deep Dive',
    desc: "A complete breakdown of Wattcoin's economic model — 21M hard cap, tier-based halving schedule, energy-backed value floor, and the 1M WTC staking rewards pool.",
    date: 'June 17, 2026',
  },
  {
    id: 'probe-system',
    title: 'How the Peer Probe System Prevents Cheating',
    desc: "A technical deep dive into Wattcoin's peer probe system — computational proof verification, trust scoring, multi-coordinator cross-attestation, and hardware identity checks.",
    date: 'June 10, 2026',
  },
];

// ── Extract article HTML content by anchor id ──
function extractArticle(blogHtml, anchorId) {
  // Find the article tag with the matching id
  const startMarker = `<article class="blog-post" id="${anchorId}">`;
  const startIdx = blogHtml.indexOf(startMarker);
  if (startIdx === -1) return null;

  // Find the closing </article>
  const endMarker = '</article>';
  const contentStart = startIdx;
  const contentEnd = blogHtml.indexOf(endMarker, contentStart);
  if (contentEnd === -1) return null;

  return blogHtml.slice(contentStart, contentEnd + endMarker.length);
}

// ── Extract post-card HTML for listing page ──
function _extractPostCard(blogHtml, anchorId) {
  // Find the full <a ... href="#anchorId" class="post-card"> ... </a>
  const pattern = `<a[^>]*href="#${anchorId}"[^>]*class="post-card"[^>]*>[\\s\\S]*?</a>`;
  const regex = new RegExp(pattern);
  const match = blogHtml.match(regex);
  return match ? match[0] : null;
}

// ── Build the head section for an individual post page ──
function buildPostHead(post, postUrl) {
  const title = `${post.title} | Wattcoin Blog`;
  const isHowTo = post.schemaType === 'HowTo';
  let howToJson = '';
  if (isHowTo && post.howToSteps) {
    howToJson = `,
        {
          "@type": "HowTo",
          "@id": "${BASE_URL}${postUrl}#howto",
          "name": "${escHtml(post.title)}",
          "description": "${escHtml(post.desc)}",
          "step": [${post.howToSteps
            .map(
              (step, i) => `
            {
              "@type": "HowToStep",
              "position": ${i + 1},
              "name": "${escHtml(step)}",
              "text": "${escHtml(step)}"
            }`,
            )
            .join(',')}
          ]
        }`;
  }
  return `    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escHtml(title)}</title>
    <meta name="description" content="${escHtml(post.desc)}" />
    <link rel="canonical" href="${BASE_URL}${postUrl}" />
    <meta property="og:title" content="${escHtml(post.title)}" />
    <meta property="og:description" content="${escHtml(post.desc)}" />
    <meta property="og:url" content="${BASE_URL}${postUrl}" />
    <meta property="og:type" content="article" />
    <meta property="og:image" content="${BASE_URL}/assets/new_icon.png" />
    <meta property="og:image:width" content="1024" />
    <meta property="og:image:height" content="1024" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="Wattcoin" />
    <meta name="robots" content="index, follow" />
    <meta name="author" content="Wattcoin Foundation" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escHtml(title)}" />
    <meta name="twitter:description" content="${escHtml(post.desc)}" />
    <meta name="twitter:image" content="${BASE_URL}/assets/new_icon.png" />
    <link rel="icon" type="image/x-icon" href="/assets/icons/icon.ico" />
    <link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/icon-32.png" />
    <link rel="icon" type="image/png" sizes="256x256" href="/assets/icons/icon-256.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/icon-256.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <link rel="stylesheet" href="/assets/fonts/fonts.css" />
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "${isHowTo ? 'Article' : 'Article'}",
          "@id": "${BASE_URL}${postUrl}#article",
          "headline": "${escHtml(post.title)}",
          "url": "${BASE_URL}${postUrl}",
          "datePublished": "${toIsoDate(post.date)}",
          "author": { "@type": "Organization", "name": "Wattcoin Foundation" },
          "publisher": { "@id": "${BASE_URL}/#organization" },
          "description": "${escHtml(post.desc)}",
          "mainEntityOfPage": { "@type": "WebPage", "@id": "${BASE_URL}${postUrl}" }
        },
        {
          "@type": "BreadcrumbList",
          "@id": "${BASE_URL}${postUrl}#breadcrumb",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": "${BASE_URL}/" },
            { "@type": "ListItem", "position": 2, "name": "Blog", "item": "${BASE_URL}/blog.html" },
            { "@type": "ListItem", "position": 3, "name": "${escHtml(post.title)}", "item": "${BASE_URL}${postUrl}" }
          ]
        }${howToJson}
      ]
    }
    </script>`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toIsoDate(dateStr) {
  const months = {
    January: '01',
    February: '02',
    March: '03',
    April: '04',
    May: '05',
    June: '06',
    July: '07',
    August: '08',
    September: '09',
    October: '10',
    November: '11',
    December: '12',
  };
  const m = String(dateStr || '').match(/^(\w+) (\d+), (\d{4})$/);
  if (!m) return '2026-01-01';
  return `${m[3]}-${months[m[1]] || '01'}-${String(m[2]).padStart(2, '0')}`;
}

// ── Extract shared page shell from blog.html ──
function extractShell(blogHtml) {
  // Get styles (everything between <style> and </style>)
  let styles = '';
  const styleMatch = blogHtml.match(/<style>[\s\S]*?<\/style>/);
  if (styleMatch) {
    // Remove borders from .blog-post that don't match the grid on single-post pages
    styles = styleMatch[0]
      .replace(/\.blog-post \{[^}]*\}/g, '.blog-post {\n        padding: 60px 0;\n      }')
      .replace(/\.blog-post:last-of-type\s*\{[^}]*\}/g, '');
  }

  // Get nav
  const navMatch = blogHtml.match(/<nav>[\s\S]*?<\/nav>/);
  const nav = navMatch ? navMatch[0] : '';

  // Get footer
  const footerMatch = blogHtml.match(/<footer>[\s\S]*?<\/footer>/);
  const footer = footerMatch ? footerMatch[0] : '';

  // Get scripts (strip trailing </body></html> from the match)
  const scriptMatch = blogHtml.match(/<script>[\s\S]*?<\/script>/g);
  const scripts = scriptMatch && scriptMatch.length > 0 ? scriptMatch[scriptMatch.length - 1] : '';

  return { styles, nav, footer, scripts };
}

// ── Build a full individual post page ──
function buildPostPage(post, articleHtml, shell) {
  const postUrl = `/blog/${post.id}.html`;
  const headMeta = buildPostHead(post, postUrl);
  // Fix the top "back to all posts" link and add one at the bottom
  const backLink = '<a href="/blog.html" class="back-link">&larr; Back to all posts</a>';
  let content = articleHtml.replace('<a href="#" class="back-link">&larr; Back to all posts</a>', backLink);
  // Convert the article's first <h2> to <h1> — it was an h2 in the listing page but
  // needs to be the primary heading on its own page
  content = content.replace('<h2>', '<h1>');
  content = content.replace('</h2>', '</h1>');
  content = content.replace('</article>', `  ${backLink}\n</article>`);

  return `<!doctype html>
<html lang="en">
  <head>
${headMeta}
    ${shell.styles}
  </head>
  <body>
    ${shell.nav}
    <div style="padding-top: 100px">
      <div class="container">
        ${content}
      </div>
    </div>
    ${shell.footer}
    ${shell.scripts}
  </body>
</html>
`;
}

// ── Generate post card HTML from post data ──
function buildPostCard(post, index) {
  const num = String(index + 1).padStart(2, '0');
  // Simple description snippet for the card
  const snippet = post.desc.split(' — ')[0] || post.desc.slice(0, 120);
  return `<a href="/blog/${post.id}.html" class="post-card">
          <div class="post-card-num">${num}</div>
          <div>
            <h3>${escHtml(post.title)}</h3>
            <p>${escHtml(snippet)}</p>
          </div>
        </a>`;
}

// ── Generate the updated blog.html listing page ──
function buildListingPage(shell) {
  const cardsHtml = POSTS.map((p, i) => buildPostCard(p, i)).join('\n        ');

  // Build the listing HTML (header + cards, no full articles)
  const listingContent = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wattcoin Blog — Mining Guides, Protocol Updates & Tutorials</title>
    <meta name="description" content="Wattcoin mining guides, protocol updates, and hardware tutorials for CPU, GPU, and ASIC mining. Proof-of-Energy explained." />
    <link rel="canonical" href="${BASE_URL}/blog.html" />
    <meta property="og:title" content="Wattcoin Blog — Mining Guides & Protocol Updates" />
    <meta property="og:description" content="Deep dives into Proof-of-Energy consensus, comparisons with Bitcoin, GPU/CPU/server/ASIC mining guides, and the Vortex hydro turbine project." />
    <meta property="og:url" content="${BASE_URL}/blog.html" />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="${BASE_URL}/assets/new_icon.png" />
    <meta property="og:image:width" content="1024" />
    <meta property="og:image:height" content="1024" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="Wattcoin" />
    <meta name="robots" content="index, follow" />
    <meta name="author" content="Wattcoin Foundation" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Wattcoin Blog — Mining Guides & Protocol Updates" />
    <meta name="twitter:description" content="Proof-of-Energy consensus, crypto mining guides, Vortex hydro turbine updates — all from the Wattcoin team." />
    <meta name="twitter:image" content="${BASE_URL}/assets/new_icon.png" />
    <link rel="icon" type="image/x-icon" href="/assets/icons/icon.ico" />
    <link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/icon-32.png" />
    <link rel="icon" type="image/png" sizes="256x256" href="/assets/icons/icon-256.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/icon-256.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <link rel="stylesheet" href="/assets/fonts/fonts.css" />
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Blog",
          "@id": "${BASE_URL}/blog.html#blog",
          "name": "Wattcoin Blog",
          "url": "${BASE_URL}/blog.html",
          "description": "Deep dives into Proof-of-Energy consensus, energy-backed cryptocurrency, mining guides, and the Vortex hydro turbine project.",
          "publisher": { "@type": "Organization", "name": "Wattcoin", "url": "${BASE_URL}" },
          "blogPost": [${POSTS.map(
            (p, _i) => `
            {
              "@type": "BlogPosting",
              "headline": "${escHtml(p.title)}",
              "url": "${BASE_URL}/blog/${p.id}.html",
              "datePublished": "${toIsoDate(p.date)}",
              "author": { "@type": "Organization", "name": "Wattcoin Foundation" },
              "description": "${escHtml(p.desc)}"
            }`,
          ).join(',')}
          ]
        },
        {
          "@type": "BreadcrumbList",
          "@id": "${BASE_URL}/blog.html#breadcrumb",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": "${BASE_URL}/" },
            { "@type": "ListItem", "position": 2, "name": "Blog", "item": "${BASE_URL}/blog.html" }
          ]
        }
      ]
    }
    </script>
    ${shell.styles}
  </head>
  <body>
    ${shell.nav}

    <div class="blog-header">
      <div class="container">
        <div class="hero-pill-row">
          <div class="hero-pill">VERSION 1.0.308 — JUNE 2026</div>
        </div>
        <h1>Wattcoin <span>Blog</span></h1>
        <p>
          Deep dives into Proof-of-Energy consensus, energy-backed cryptocurrency, CPU/GPU/server/ASIC mining guides,
          and the Vortex hydro turbine project.
        </p>
      </div>
    </div>

    <div class="container">
      <div class="post-list">
        ${cardsHtml}
      </div>
    </div>

    ${shell.footer}
    ${shell.scripts}
  </body>
</html>
`;
  return listingContent;
}

// ── Main ──
function main() {
  const blogDir = path.join(ROOT, 'website/blog');
  fs.mkdirSync(blogDir, { recursive: true });

  const shell = extractShell(BLOG_SRC);
  const articleContents = [];

  // Map anchor IDs to POSTS
  const anchorMap = {
    'what-is-proof-of-energy-consensus': 'proof-of-energy-consensus',
    'what-is-the-vortex-initiative': 'vortex-initiative',
    'energy-backed-crypto-vs-bitcoin': 'energy-backed-crypto-vs-bitcoin',
    'how-to-mine-cryptocurrency-with-cpu': 'mine-cryptocurrency-with-cpu',
    'how-to-mine-cryptocurrency-with-gpu': 'mine-cryptocurrency-with-gpu',
    'enterprise-mining-with-server-hardware': 'enterprise-mining-server-hardware',
    'asic-mining-and-wattcoin': 'asic-mining-wattcoin',
    'recover-contributions-after-reinstall': 'recovering-contributions-after-reinstall',
    'wattcoin-tokenomics-deep-dive': 'tokenomics-deep-dive',
  };

  for (const post of POSTS) {
    // Find the anchor id used in blog.html
    const anchorId = Object.keys(anchorMap).find((k) => anchorMap[k] === post.id) || post.id;
    post.anchorId = anchorId;

    const articleHtml = extractArticle(BLOG_SRC, anchorId);
    if (!articleHtml) {
      console.error(`  ✗ Article not found for: ${post.id} (anchor: ${anchorId})`);
      continue;
    }
    articleContents.push({ post, html: articleHtml });
  }

  // Generate individual post pages
  for (const { post, html } of articleContents) {
    const pageHtml = buildPostPage(post, html, shell);
    const filePath = path.join(blogDir, `${post.id}.html`);
    fs.writeFileSync(filePath, pageHtml, 'utf8');
    console.log(`  ✓ website/blog/${post.id}.html`);
  }

  // Generate blog listing
  const listingHtml = buildListingPage(shell);
  fs.writeFileSync(BLOG_FILE, listingHtml, 'utf8');
  console.log(`  ✓ website/blog.html (listing page)`);
}

main();
