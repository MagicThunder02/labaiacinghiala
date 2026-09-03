#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const {
  StorageMigrationError,
  analyzeStorageMigration,
  applyStorageMigration,
} = require('../src/services/storage-migration-service');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function resolveProjectPath(value, fallback) {
  const selected = String(value || '').trim() || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(projectRoot, selected);
}

function usage() {
  return [
    'Uso:',
    '  npm.cmd run storage:migrate -- --dry-run',
    '  npm.cmd run storage:migrate -- --apply',
    '',
    'Opzioni:',
    '  --dry-run              Analizza senza modificare SQLite o creare backup.',
    '  --apply                Crea un backup e applica la migrazione.',
    '  --database <percorso>  Sovrascrive DATABASE_PATH.',
    '  --library <percorso>   Sovrascrive LIBRARY_PATH.',
    '  --backups <percorso>   Sovrascrive DATABASE_BACKUPS_PATH.',
    '  --json                 Stampa il rapporto in JSON.',
    '  --help                 Mostra questo aiuto.',
  ].join('\n');
}

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Manca il valore di ${name}.`);
  return value;
}

function parseArguments(argv) {
  const options = {
    mode: null,
    databasePath: resolveProjectPath(process.env.DATABASE_PATH, './data/media.sqlite'),
    libraryPath: resolveProjectPath(process.env.LIBRARY_PATH, './media'),
    backupsPath: resolveProjectPath(process.env.DATABASE_BACKUPS_PATH, './data/backups'),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (options.mode && options.mode !== 'dry-run') throw new Error('Usa soltanto uno tra --dry-run e --apply.');
      options.mode = 'dry-run';
    } else if (argument === '--apply') {
      if (options.mode && options.mode !== 'apply') throw new Error('Usa soltanto uno tra --dry-run e --apply.');
      options.mode = 'apply';
    } else if (argument === '--database') {
      options.databasePath = path.resolve(optionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--library') {
      options.libraryPath = path.resolve(optionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--backups') {
      options.backupsPath = path.resolve(optionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Opzione sconosciuta: ${argument}`);
    }
  }

  if (!options.help && !options.mode) throw new Error('Specifica --dry-run oppure --apply.');
  return options;
}

function printCategory(category) {
  console.log(
    `${category.label}: ${category.records} record; `
    + `${category.migratable} da migrare; `
    + `${category.alreadyPortable} già portabili; `
    + `${category.missing} mancanti.`,
  );
}

function printReport(report, mode) {
  console.log('');
  const title = mode === 'dry-run'
    ? 'analisi senza modifiche'
    : report.applied
      ? 'migrazione applicata'
      : 'verifica prima dell’applicazione';
  console.log(`Step 23E — ${title}`);
  console.log(`Database: ${report.databasePath}`);
  console.log(`Libreria: ${report.libraryPath}`);
  console.log(`Schema SQLite: ${report.schemaVersion}`);
  console.log('');
  printCategory(report.categories.movies);
  printCategory(report.categories.series);
  printCategory(report.categories.reading);
  printCategory(report.categories.music);
  console.log('');
  console.log(`Aggiornamenti SQL pianificati: ${report.summary.changes}`);
  console.log(`Percorsi assoluti legacy da convertire: ${report.legacyAbsolutePaths}`);
  console.log(`Percorsi esterni/non ricostruibili: ${report.summary.externalPaths}`);
  console.log(`File o cartelle mancanti: ${report.summary.missing}`);
  console.log(`Cache musicali da invalidare: ${report.cacheEntriesInvalidated}`);
  console.log(`Errori bloccanti: ${report.summary.errors}`);
  console.log(`Avvisi: ${report.summary.warnings}`);

  const importantIssues = report.issues.slice(0, 20);
  if (importantIssues.length) {
    console.log('');
    console.log('Dettagli:');
    for (const issue of importantIssues) {
      console.log(`- [${issue.severity === 'error' ? 'ERRORE' : 'AVVISO'}] ${issue.message}`);
    }
    if (report.issues.length > importantIssues.length) {
      console.log(`- ... altri ${report.issues.length - importantIssues.length} elementi nel rapporto JSON.`);
    }
  }

  if (report.backupPath) {
    console.log('');
    console.log(`Backup creato: ${report.backupPath}`);
  }
  console.log('');
  if (mode === 'dry-run') {
    console.log(report.canApply
      ? 'Esito: il database può essere migrato con --apply.'
      : 'Esito: migrazione bloccata; correggere gli errori prima di usare --apply.');
  } else if (report.applied) {
    console.log(`Esito: migrazione completata (${report.appliedChanges} aggiornamenti).`);
  } else if (!report.canApply) {
    console.log('Esito: applicazione non eseguita a causa degli errori bloccanti.');
  } else {
    console.log('Esito: il database era già portabile; nessuna modifica applicata.');
  }
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const report = options.mode === 'apply'
      ? applyStorageMigration(options)
      : analyzeStorageMigration(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, options.mode);
    if (!report.canApply) process.exitCode = 2;
  } catch (error) {
    const report = error instanceof StorageMigrationError ? error.details?.report : null;
    if (options.json && report) console.log(JSON.stringify(report, null, 2));
    else if (report) printReport(report, options.mode);
    console.error(`Errore: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
