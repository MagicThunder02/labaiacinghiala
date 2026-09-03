const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../database');

let backupPromise = null;
let dailyTimer = null;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeReason(reason) {
  return String(reason || 'automatico')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'automatico';
}

function backupKind(name) {
  if (name.endsWith('-giornaliero.sqlite')) return 'daily';
  if (name.endsWith('-mensile.sqlite')) return 'monthly';
  return 'other';
}

async function listDatabaseBackups() {
  const entries = await fs.readdir(config.databaseBackupsPath, { withFileTypes: true }).catch(() => []);
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
    const fullPath = path.join(config.databaseBackupsPath, entry.name);
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats) continue;
    backups.push({
      name: entry.name,
      fullPath,
      mtimeMs: stats.mtimeMs,
      kind: backupKind(entry.name),
    });
  }
  return backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function pruneDatabaseBackups() {
  const backups = await listDatabaseBackups();
  const daily = backups.filter((item) => item.kind === 'daily');
  const monthly = backups.filter((item) => item.kind === 'monthly');
  const toRemove = [
    ...daily.slice(config.databaseDailyBackupRetention),
    ...monthly.slice(config.databaseMonthlyBackupRetention),
  ];
  await Promise.all(toRemove.map((item) => fs.rm(item.fullPath, { force: true }).catch(() => {})));
  return {
    dailyKept: Math.min(daily.length, config.databaseDailyBackupRetention),
    monthlyKept: Math.min(monthly.length, config.databaseMonthlyBackupRetention),
    removed: toRemove.length,
  };
}

async function createDatabaseBackup(reason = 'automatico') {
  if (backupPromise) return backupPromise;
  backupPromise = (async () => {
    await fs.mkdir(config.databaseBackupsPath, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(
      config.databaseBackupsPath,
      `media-${stamp}-${safeReason(reason)}.sqlite`,
    );
    db.exec(`VACUUM INTO ${sqlString(destination)}`);
    await pruneDatabaseBackups();
    return destination;
  })();

  try {
    return await backupPromise;
  } finally {
    backupPromise = null;
  }
}

function sameLocalMonth(timestampMs, referenceDate) {
  const date = new Date(timestampMs);
  return date.getFullYear() === referenceDate.getFullYear()
    && date.getMonth() === referenceDate.getMonth();
}

async function ensureMonthlyBackup(referenceDate = new Date()) {
  const backups = await listDatabaseBackups();
  const alreadyPresent = backups.some((item) => (
    item.kind === 'monthly' && sameLocalMonth(item.mtimeMs, referenceDate)
  ));
  if (alreadyPresent) return null;
  return createDatabaseBackup('mensile');
}

async function runScheduledBackups(referenceDate = new Date()) {
  const daily = await createDatabaseBackup('giornaliero');
  const monthly = await ensureMonthlyBackup(referenceDate);
  return { daily, monthly };
}

function millisecondsUntilNextDailyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyBackups() {
  if (dailyTimer) return;
  pruneDatabaseBackups().catch((error) => {
    console.warn('Pulizia backup non riuscita:', error.message);
  });
  const scheduleNext = () => {
    dailyTimer = setTimeout(async () => {
      try {
        await runScheduledBackups();
      } catch (error) {
        console.warn('Backup automatico non riuscito:', error.message);
      } finally {
        dailyTimer = null;
        scheduleNext();
      }
    }, millisecondsUntilNextDailyBackup());
    dailyTimer.unref?.();
  };
  scheduleNext();
}

module.exports = {
  createDatabaseBackup,
  ensureMonthlyBackup,
  listDatabaseBackups,
  pruneDatabaseBackups,
  runScheduledBackups,
  scheduleDailyBackups,
};
