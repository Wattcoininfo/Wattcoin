const BACKUP_FILE_EXTENSION = 'wcbak';
const BACKUP_FORMAT_VERSION = 1;

function parseBackupContainer(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('Invalid backup file format (JSON parsing failed).');
  }

  const format = parsed && parsed.format;
  const version = parsed && parsed.version;
  if (format !== 'WATTCOIN_WALLET_BACKUP' || version !== BACKUP_FORMAT_VERSION) {
    throw new Error('Unsupported backup format version.');
  }

  if (!parsed.encrypted || typeof parsed.encrypted !== 'object') {
    throw new Error('Backup is missing encrypted payload.');
  }

  return parsed;
}

module.exports = { BACKUP_FILE_EXTENSION, BACKUP_FORMAT_VERSION, parseBackupContainer };
