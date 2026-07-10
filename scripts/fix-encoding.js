'use strict';
// Fix mojibake (double-encoded UTF-8 read as Latin-1) in source files.
// Each pair is [broken bytes as they appear in the file, correct Unicode char].
const fs = require('fs');
const path = require('path');

const FILES = [
  path.join(__dirname, '..', 'electron-main.js'),
  path.join(__dirname, '..', 'Miner.jsx'),
  path.join(__dirname, '..', 'MiningLog.jsx'),
];

// Mojibake sequences: UTF-8 bytes misread as Windows-1252
// E.g. em dash U+2014 (bytes E2 80 94) read via CP1252: E2→â, 80→€, 94→"
const REPLACEMENTS = [
  ['\u00e2\u20ac\u201d', '\u2014'], // â€" -> — em dash        (E2 80 94)
  ['\u00e2\u20ac\u2018', '\u2013'], // â€" -> – en dash         (E2 80 93) -- check
  ['\u00e2\u20ac\u02dc', '\u2018'], // â€˜ -> ' left single q.  (E2 80 98)
  ['\u00e2\u20ac\u2122', '\u2019'], // â€™ -> ' right single q. (E2 80 99)
  ['\u00e2\u20ac\u0153', '\u201c'], // â€œ -> " left double q.  (E2 80 9C)
  ['\u00e2\u20ac\u00a6', '\u2026'], // â€¦ -> … ellipsis        (E2 80 A6)
  ['\u00c3\u2014', '\u00d7'], // Ã— -> × multiplication  (C3 97)
  ['\u00c3\u00a9', '\u00e9'], // Ã© -> é                 (C3 A9)
  ['\u00e2\u201d\u20ac', '\u2500'], // â"€ -> ─ box drawing     (E2 94 80)
  ['\u00e2\u2030\u00a4', '\u2264'], // â‰¤ -> ≤ less-or-equal  (E2 89 A4)
  ['\u00e2\u2030\u00a5', '\u2265'], // â‰¥ -> ≥ greater-or-eq  (E2 89 A5)
];

let totalFiles = 0;
for (const file of FILES) {
  try {
    const orig = fs.readFileSync(file, 'utf8');
    let fixed = orig;
    for (const [from, to] of REPLACEMENTS) {
      // Replace all occurrences
      let i = 0;
      while ((i = fixed.indexOf(from, i)) !== -1) {
        fixed = fixed.slice(0, i) + to + fixed.slice(i + from.length);
        i += to.length;
      }
    }
    if (fixed !== orig) {
      fs.writeFileSync(file, fixed, 'utf8');
      console.log('Fixed: ' + file);
      totalFiles++;
    } else {
      console.log('Clean: ' + file);
    }
  } catch (e) {
    console.error('ERROR ' + file + ': ' + e.message);
  }
}
console.log('\nDone. Files fixed: ' + totalFiles);
