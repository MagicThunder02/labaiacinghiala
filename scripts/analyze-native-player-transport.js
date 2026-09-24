#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const csv = process.argv.includes('--csv');

if (!files.length) {
  console.error('Uso: node scripts/analyze-native-player-transport.js [--csv] <native-player-diagnostic.log> [...]');
  process.exit(2);
}

function kv(line) {
  const out = {};
  for (const match of line.matchAll(/([A-Za-z0-9_]+)=([^\s]+)/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

function num(value) {
  if (value === undefined) return null;
  const parsed = Number(String(value).replace(/,$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let summary = null;
  let fileLoadedMs = null;
  let revealMs = null;
  let teardownMs = null;
  let slowOperations = 0;
  let maxSlowOperationMs = 0;

  for (const line of lines) {
    if (line.includes('native_player transport_summary ')) summary = kv(line);
    if (line.includes('native_player event=file_loaded ')) {
      fileLoadedMs = num(kv(line).open_to_file_loaded_ms) ?? fileLoadedMs;
    }
    if (line.includes('native_player playback_intro=complete ')) {
      revealMs = num(kv(line).open_to_reveal_ms) ?? revealMs;
    }
    if (line.includes('native_player event=closed ')) {
      teardownMs = num(kv(line).teardown_ms) ?? teardownMs;
    }
    if (line.includes('native_player latency=slow ')) {
      slowOperations += 1;
      maxSlowOperationMs = Math.max(maxSlowOperationMs, num(kv(line).elapsed_ms) || 0);
    }
  }

  if (!summary) {
    throw new Error(`Nessun transport_summary trovato in ${file}`);
  }

  const bytesReceived = num(summary.bytes_received) || 0;
  const bytesServed = num(summary.bytes_served) || 0;
  const maxRangeBytes = num(summary.max_range_bytes) || 0;
  const windowBytes = num(summary.window_bytes) || 0;

  return {
    file: path.basename(file),
    maxRangeMiB: maxRangeBytes / 1048576,
    windowMiB: windowBytes / 1048576,
    requests: num(summary.remote_requests),
    receivedMiB: bytesReceived / 1048576,
    servedMiB: bytesServed / 1048576,
    usefulRatio: num(summary.useful_ratio),
    metadataMs: num(summary.metadata_ms),
    firstRangeMs: num(summary.first_range_elapsed_ms),
    avgHeadersMs: num(summary.avg_headers_ms),
    avgBodyMs: num(summary.avg_body_ms),
    avgRangeMs: num(summary.avg_range_ms),
    maxRangeMs: num(summary.max_range_ms),
    blockingFetches: num(summary.blocking_fetches),
    avgBlockingFetchMs: num(summary.avg_blocking_fetch_ms),
    maxBlockingFetchMs: num(summary.blocking_fetch_ms_max),
    slow250: num(summary.slow_250),
    slow500: num(summary.slow_500),
    slow1000: num(summary.slow_1000),
    cachePauseCount: num(summary.cache_pause_count),
    cachePauseTotalMs: num(summary.cache_pause_total_ms),
    cachePauseMaxMs: num(summary.cache_pause_max_ms),
    seeks: num(summary.seeks),
    cacheSeekHits: num(summary.cache_seek_hits),
    maxSeekMiB: (num(summary.seek_distance_bytes_max) || 0) / 1048576,
    fileLoadedMs,
    revealMs,
    teardownMs,
    slowOperations,
    maxSlowOperationMs,
  };
}

const rows = [];
for (const file of files) {
  try {
    rows.push(analyze(file));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (!rows.length) process.exit(process.exitCode || 1);

for (const row of rows) {
  for (const key of ['maxRangeMiB', 'windowMiB', 'receivedMiB', 'servedMiB', 'maxSeekMiB']) {
    if (typeof row[key] === 'number') row[key] = Number(row[key].toFixed(2));
  }
}

if (csv) {
  const columns = Object.keys(rows[0]);
  const esc = (value) => {
    const str = value == null ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  console.log(columns.join(','));
  for (const row of rows) console.log(columns.map((column) => esc(row[column])).join(','));
} else {
  console.table(rows);
  console.log('\nLettura rapida: cachePauseCount deve idealmente restare 0; maxBlockingFetchMs e slow500/slow1000 mostrano quanto un confine di Range puo bloccare read_into(); usefulRatio basso dopo seek indica overfetch/spreco.');
}
