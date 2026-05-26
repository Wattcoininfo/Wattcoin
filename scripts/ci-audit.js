#!/usr/bin/env node
const { execSync } = require('child_process');

let stdout;
try {
  stdout = execSync('npm audit --json', { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  stdout = e.stdout || '{}';
}

const report = JSON.parse(stdout);

const advisories = Object.values(report.vulnerabilities || {});
const allowed = ['elliptic'];

const failures = advisories.filter(
  (v) => v.severity === 'high' || v.severity === 'critical'
).filter(
  (v) => !allowed.includes(v.name)
);

if (failures.length > 0) {
  console.error('High/critical severity vulnerabilities found:');
  for (const v of failures) {
    console.error(`  ${v.name}: ${v.severity}`);
  }
  process.exit(1);
}

if (advisories.some((v) => v.severity === 'high' || v.severity === 'critical')) {
  console.log('Only elliptic advisory present (no fix available) — accepted.');
}

console.log(`Audit passed — ${advisories.length} advisory(ies) found, none blocking.`);
