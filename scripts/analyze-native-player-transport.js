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
  const remoteRequests = num(summary.remote_requests);
  const prefetchRequests = num(summary.prefetch_requests);
  const prefetchHits = num(summary.prefetch_hits);
  const prefetchWaits = num(summary.prefetch_waits);
  const prefetchWaitTotalMs = num(summary.prefetch_wait_ms_total);
  const reservoirRangesScheduled = num(summary.reservoir_ranges_scheduled);
  const reservoirRangesCompleted = num(summary.reservoir_ranges_completed);

  return {
    file: path.basename(file),
    maxRangeMiB: maxRangeBytes / 1048576,
    windowMiB: windowBytes / 1048576,
    reservoirLowMiB: (num(summary.reservoir_low_bytes) || 0) / 1048576,
    reservoirHighMiB: (num(summary.reservoir_high_bytes) || 0) / 1048576,
    reservoirDepthMiB: (num(summary.reservoir_depth_bytes) || 0) / 1048576,
    reservoirDepthPeakMiB: (num(summary.reservoir_depth_peak_bytes) || 0) / 1048576,
    requests: remoteRequests,
    foregroundRequests: remoteRequests != null && prefetchRequests != null
      ? remoteRequests - prefetchRequests
      : null,
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
    prefetchRequests,
    prefetchHits,
    prefetchHitRate: prefetchRequests > 0 && prefetchHits != null
      ? Number((prefetchHits / prefetchRequests).toFixed(3))
      : null,
    prefetchWaits,
    prefetchWaitTotalMs,
    prefetchWaitAvgMs: prefetchWaits > 0 && prefetchWaitTotalMs != null
      ? Number((prefetchWaitTotalMs / prefetchWaits).toFixed(1))
      : null,
    prefetchWaitMaxMs: num(summary.prefetch_wait_ms_max),
    prefetchWaitExtensions: num(summary.prefetch_wait_extensions),
    prefetchFallbacks: num(summary.prefetch_fallbacks),
    prefetchFallbackStalled: num(summary.prefetch_fallback_stalled),
    prefetchFallbackHard: num(summary.prefetch_fallback_hard),
    prefetchCancelled: num(summary.prefetch_cancelled),
    prefetchStale: num(summary.prefetch_stale_results),
    prefetchErrors: num(summary.prefetch_errors),
    prefetchDiscardedMiB: (num(summary.prefetch_bytes_discarded) || 0) / 1048576,
    reservoirRefills: num(summary.reservoir_refills),
    reservoirRangesScheduled,
    reservoirRangesCompleted,
    reservoirCompletionRate: reservoirRangesScheduled > 0 && reservoirRangesCompleted != null
      ? Number((reservoirRangesCompleted / reservoirRangesScheduled).toFixed(3))
      : null,
    reservoirCompletedMiB: (num(summary.reservoir_bytes_completed) || 0) / 1048576,
    readCalls: num(summary.read_calls),
    trueEofReads: num(summary.true_eof_reads),
    nonEofZeroReadsPrevented: num(summary.non_eof_zero_reads_prevented),
    nonEofZeroReadFailures: num(summary.non_eof_zero_read_failures),
    lastNonEofZeroPositionMiB: (num(summary.last_non_eof_zero_position) || 0) / 1048576,
    lastNonEofZeroRemainingMiB: (num(summary.last_non_eof_zero_remaining) || 0) / 1048576,
    lastNonEofZeroGeneration: num(summary.last_non_eof_zero_generation),
    lastReadPositionMiB: (num(summary.last_read_position) || 0) / 1048576,
    lastReadRequestedKiB: (num(summary.last_read_requested) || 0) / 1024,
    lastReadReturnedKiB: (num(summary.last_read_returned) || 0) / 1024,
    lastReadRemainingMiB: (num(summary.last_read_remaining) || 0) / 1048576,
    sourceSizeMiB: (num(summary.source_size) || 0) / 1048576,
    seekToEofCount: num(summary.seek_to_eof_count),
    lastSeekOffsetMiB: (num(summary.last_seek_offset) || 0) / 1048576,
    lastSeekPreviousMiB: (num(summary.last_seek_previous_position) || 0) / 1048576,
    prematureEndFiles: num(summary.premature_end_files),
    endFileRecoveries: num(summary.end_file_recoveries),
    endFileRecoveryFailures: num(summary.end_file_recovery_failures),
    slow250: num(summary.slow_250),
    slow500: num(summary.slow_500),
    slow1000: num(summary.slow_1000),
    cachePauseCount: num(summary.cache_pause_count),
    cachePauseTotalMs: num(summary.cache_pause_total_ms),
    cachePauseMaxMs: num(summary.cache_pause_max_ms),
    seeks: num(summary.seeks),
    cacheSeekHits: num(summary.cache_seek_hits),
    seekCacheMisses: num(summary.seek_cache_misses),
    seekCacheHitRate: num(summary.seeks) > 0 && num(summary.cache_seek_hits) != null
      ? Number((num(summary.cache_seek_hits) / num(summary.seeks)).toFixed(3))
      : null,
    cachePeakMiB: (num(summary.cache_peak_bytes) || 0) / 1048576,
    cacheSegments: num(summary.cache_segments),
    cachePeakSegments: num(summary.cache_peak_segments),
    cacheEvictions: num(summary.cache_evictions),
    cacheEvictedMiB: (num(summary.cache_evicted_bytes) || 0) / 1048576,
    cachePreservedMissMiB: (num(summary.cache_preserved_miss_bytes) || 0) / 1048576,
    cachePreservedMissSegments: num(summary.cache_preserved_miss_segments),
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
  for (const key of ['maxRangeMiB', 'windowMiB', 'reservoirLowMiB', 'reservoirHighMiB', 'reservoirDepthMiB', 'reservoirDepthPeakMiB', 'reservoirCompletedMiB', 'receivedMiB', 'servedMiB', 'cachePeakMiB', 'cacheEvictedMiB', 'cachePreservedMissMiB', 'maxSeekMiB', 'prefetchDiscardedMiB', 'lastNonEofZeroPositionMiB', 'lastNonEofZeroRemainingMiB', 'lastReadPositionMiB', 'lastReadRemainingMiB', 'lastReadRequestedKiB', 'lastReadReturnedKiB', 'sourceSizeMiB', 'lastSeekOffsetMiB', 'lastSeekPreviousMiB']) {
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
  console.log('\nLettura rapida: 6B.7.3.2 mantiene sparse cache + reservoir + recovery END_FILE e aggiunge un guard nel read callback: un read da 0 byte e consentito solo al vero EOF. Guarda nonEofZeroReadsPrevented/nonEofZeroReadFailures, trueEofReads, seekToEofCount e lastNonEofZeroPositionMiB per distinguere un falso EOF della sorgente da un EOF reale o da un seek esplicito alla fine del file.');
}
