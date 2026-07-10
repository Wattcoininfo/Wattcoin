const fs = require('fs');
const path = require('path');

const SOURCE_FILE_EXTENSIONS = new Set(['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'crap',
  'dist',
  'build',
  'resources',
  'releases',
  'artifacts',
  'coverage',
]);

function listSourceFiles(root, dir = root, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(root, absPath);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      listSourceFiles(root, absPath, files);
      continue;
    }
    if (!SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    files.push({ absPath, relPath: relPath.replace(/\\/g, '/') });
  }
  return files;
}

function detectObfuscation(sourceText) {
  const sample = String(sourceText || '').slice(0, 12000);
  const reasons = [];
  const hexSymbolRefs = sample.match(/_0x[a-f0-9]{4,}/gi) || [];
  const hexCallRefs = sample.match(/_0x[a-f0-9]{4,}\(/gi) || [];

  if (/^const _0x[a-f0-9]{4,}\s*=\s*_0x[a-f0-9]{4,};/im.test(sample)) {
    reasons.push('hex alias bootstrap');
  }
  if (/^\s*\(function \(_0x[a-f0-9]{4,},\s*_0x[a-f0-9]{4,}\) \{/im.test(sample)) {
    reasons.push('array-rotator wrapper');
  }
  if (/while \(!{2}\[\]\)/.test(sample)) {
    reasons.push('boolean-array loop marker');
  }
  if (hexSymbolRefs.length >= 40) {
    reasons.push(`dense hex identifiers (${hexSymbolRefs.length})`);
  }
  if (hexCallRefs.length >= 8) {
    reasons.push(`dense hex decoder calls (${hexCallRefs.length})`);
  }

  return reasons;
}

function findObfuscatedSources(root) {
  const matches = [];
  for (const file of listSourceFiles(root)) {
    const sourceText = fs.readFileSync(file.absPath, 'utf8');
    const reasons = detectObfuscation(sourceText);
    if (reasons.length === 0) continue;
    matches.push({ ...file, reasons });
  }
  return matches;
}

function assertUnobfuscatedDevSources(root) {
  const matches = findObfuscatedSources(root);
  if (matches.length === 0) return [];
  const details = matches.map((entry) => `- ${entry.relPath}: ${entry.reasons.join(', ')}`).join('\n');
  throw new Error('Obfuscated developer source files detected. Developer files must stay readable.\n' + details);
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    assertUnobfuscatedDevSources(root);
    console.log(`[check-dev-source] OK: scanned ${listSourceFiles(root).length} source files.`);
  } catch (error) {
    console.error('[check-dev-source] FAIL');
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  assertUnobfuscatedDevSources,
  findObfuscatedSources,
};
