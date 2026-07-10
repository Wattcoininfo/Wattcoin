#!/usr/bin/env node
const { execSync } = require('child_process');

const pkg = require('../package.json');
const deployed = pkg.version;

const parts = deployed.split('.').map(Number);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

let lastMsg;
try {
  lastMsg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
} catch {
  lastMsg = '';
}

const match = lastMsg.match(/v(\d+\.\d+\.\d+)/);
if (match && match[1] === next) {
  console.log(`Already using v${next} (same as last commit). Use v${next} again.`);
} else {
  console.log(`Deployed version (package.json): ${deployed}`);
  console.log(`Next commit version:             v${next}`);
}
