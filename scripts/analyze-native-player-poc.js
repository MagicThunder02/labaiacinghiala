#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function parseConnectorLog(text) {
  const connections = new Set();
  let mediaRequests = 0;
  let reused = 0;
  let maxRequestIndex = 0;
  let brokenPipes = 0;

  let directFileRequests = 0;
  let directFileGetRequests = 0;
  let directRequestedBytes = 0;
  let directBytesStreamed = 0;
  let directZeroByteGets = 0;
  let directClientDisconnects = 0;
  let directControlElapsedMs = 0;
  let directElapsedMs = 0;
  let directMaxElapsedMs = 0;

  for (const line of String(text).split(/\r?\n/)) {
    if (/broken pipe/i.test(line)) brokenPipes += 1;

    const connection = line.match(/connector_connection_id=([^\s]+)\s+request_index_on_connection=(\d+)\s+transport_reused=(true|false)\s+route=([^\s]+)/);
    if (connection && connection[4] === '/baia/v1/media') {
      mediaRequests += 1;
      connections.add(connection[1]);
      if (connection[3] === 'true') reused += 1;
      maxRequestIndex = Math.max(maxRequestIndex, Number(connection[2]));
    }

    const direct = line.match(/media_source=direct_file\s+method=([^\s]+)\s+requested_start=(\d+)\s+requested_end=(\d+)\s+requested_bytes=(\d+)\s+bytes_streamed=(\d+)\s+client_disconnected=(true|false)\s+status=(\d+)\s+control_elapsed_ms=(\d+)\s+elapsed_ms=(\d+)/);
    if (direct) {
      directFileRequests += 1;
      const method = direct[1];
      const requestedBytes = Number(direct[4]);
      const streamed = Number(direct[5]);
      const disconnected = direct[6] === 'true';
      const controlMs = Number(direct[8]);
      const elapsedMs = Number(direct[9]);
      if (method === 'GET') {
        directFileGetRequests += 1;
        directRequestedBytes += requestedBytes;
        directBytesStreamed += streamed;
        if (streamed === 0) directZeroByteGets += 1;
        if (disconnected) directClientDisconnects += 1;
        directControlElapsedMs += controlMs;
        directElapsedMs += elapsedMs;
        directMaxElapsedMs = Math.max(directMaxElapsedMs, elapsedMs);
      }
      continue;
    }

    // Compatibilità con i log Phase 3, privi dei campi diagnostici estesi.
    if (/media_source=direct_file\b/.test(line)) directFileRequests += 1;
  }

  return {
    mediaRequests,
    distinctTlsConnections: connections.size,
    reusedRequests: reused,
    reusePercent: mediaRequests ? round(reused / mediaRequests * 100) : 0,
    maxRequestIndexOnConnection: maxRequestIndex,
    brokenPipes,
    directFile: {
      requests: directFileRequests,
      getRequests: directFileGetRequests,
      requestedBytes: directRequestedBytes,
      bytesStreamed: directBytesStreamed,
      completionPercent: directRequestedBytes ? round(directBytesStreamed / directRequestedBytes * 100) : 0,
      zeroByteGets: directZeroByteGets,
      clientDisconnects: directClientDisconnects,
      averageControlMs: directFileGetRequests ? round(directControlElapsedMs / directFileGetRequests) : 0,
      averageElapsedMs: directFileGetRequests ? round(directElapsedMs / directFileGetRequests) : 0,
      maxElapsedMs: directMaxElapsedMs,
    },
  };
}

function parseClientLog(text) {
  const outcomes = { complete: 0, superseded: 0, client_disconnected: 0, other: 0 };
  let ranges = 0;
  let segments = 0;
  let bytesFromConnector = 0;
  let bytesToConsumer = 0;
  let bytesDiscarded = 0;

  let nativeSourceRanges = 0;
  let nativeSourceBytes = 0;
  let nativeSourceRangeElapsedMs = 0;
  let nativeSourceRangeMaxMs = 0;
  let nativeSourceSeeks = 0;
  let nativeSourceCacheSeekHits = 0;
  let nativeSourceErrors = 0;
  let nativeSourceMaxGeneration = 0;
  const nativeRangeSizes = new Map();
  const nativePoolSlots = new Map();
  let nativeClose = null;

  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/video_range_id=([^\s]+)\s+event=end\s+result=([^\s]+)\s+requested_start=(\d+)\s+requested_end=([^\s]+)\s+segment_count=(\d+)\s+bytes_from_connector=(\d+)\s+bytes_to_webview=(\d+)\s+bytes_discarded=(\d+)/);
    if (match) {
      ranges += 1;
      const outcome = Object.hasOwn(outcomes, match[2]) ? match[2] : 'other';
      outcomes[outcome] += 1;
      segments += Number(match[5]);
      bytesFromConnector += Number(match[6]);
      bytesToConsumer += Number(match[7]);
      bytesDiscarded += Number(match[8]);
      continue;
    }

    const nativeRangeV4 = line.match(/native_media_source\s+event=range\s+generation=(\d+)\s+pool_slot=(\d+)\s+requested_start=(\d+)\s+requested_end=(\d+)\s+requested_bytes=(\d+)\s+bytes_received=(\d+)\s+elapsed_ms=(\d+)\s+sequential_fetches=(\d+)\s+cache_start=(\d+)\s+cache_end=(\d+)\s+cache_window_bytes=(\d+)/);
    if (nativeRangeV4) {
      const generation = Number(nativeRangeV4[1]);
      const poolSlot = Number(nativeRangeV4[2]);
      const bytes = Number(nativeRangeV4[6]);
      const elapsed = Number(nativeRangeV4[7]);
      nativeSourceRanges += 1;
      nativeSourceBytes += bytes;
      nativeSourceRangeElapsedMs += elapsed;
      nativeSourceRangeMaxMs = Math.max(nativeSourceRangeMaxMs, elapsed);
      nativeSourceMaxGeneration = Math.max(nativeSourceMaxGeneration, generation);
      nativeRangeSizes.set(bytes, (nativeRangeSizes.get(bytes) || 0) + 1);
      nativePoolSlots.set(poolSlot, (nativePoolSlots.get(poolSlot) || 0) + 1);
      continue;
    }

    const nativeRangeV3 = line.match(/native_media_source\s+event=range\s+start=(\d+)\s+end=(\d+)\s+bytes=(\d+)\s+elapsed_ms=(\d+)/);
    if (nativeRangeV3) {
      const bytes = Number(nativeRangeV3[3]);
      const elapsed = Number(nativeRangeV3[4]);
      nativeSourceRanges += 1;
      nativeSourceBytes += bytes;
      nativeSourceRangeElapsedMs += elapsed;
      nativeSourceRangeMaxMs = Math.max(nativeSourceRangeMaxMs, elapsed);
      nativeRangeSizes.set(bytes, (nativeRangeSizes.get(bytes) || 0) + 1);
      continue;
    }

    const seek = line.match(/native_media_source\s+event=seek\s+offset=(\d+)(?:\s+cache_hit=(true|false)\s+generation=(\d+)\s+next_range_bytes=(\d+))?/);
    if (seek) {
      nativeSourceSeeks += 1;
      if (seek[2] === 'true') nativeSourceCacheSeekHits += 1;
      if (seek[3]) nativeSourceMaxGeneration = Math.max(nativeSourceMaxGeneration, Number(seek[3]));
      continue;
    }

    const close = line.match(/native_media_source\s+event=close\s+remote_requests=(\d+)\s+bytes_requested=(\d+)\s+bytes_received=(\d+)\s+bytes_served_to_mpv=(\d+)\s+cache_hits=(\d+)\s+cache_misses=(\d+)\s+cache_seek_hits=(\d+)\s+seeks=(\d+)\s+errors=(\d+)\s+generation=(\d+)\s+pool_slot_0_requests=(\d+)\s+pool_slot_1_requests=(\d+)/);
    if (close) {
      nativeClose = {
        remoteRequests: Number(close[1]),
        bytesRequested: Number(close[2]),
        bytesReceived: Number(close[3]),
        bytesServedToMpv: Number(close[4]),
        cacheHits: Number(close[5]),
        cacheMisses: Number(close[6]),
        cacheSeekHits: Number(close[7]),
        seeks: Number(close[8]),
        errors: Number(close[9]),
        generation: Number(close[10]),
        poolSlot0Requests: Number(close[11]),
        poolSlot1Requests: Number(close[12]),
      };
      continue;
    }

    if (/native_media_source\s+event=(?:read_error|seek_error|open_error)\b/.test(line)) nativeSourceErrors += 1;
  }

  const nativeSourceAverageRangeMs = nativeSourceRanges
    ? round(nativeSourceRangeElapsedMs / nativeSourceRanges)
    : 0;
  const nativeSourceThroughputMbps = nativeSourceRangeElapsedMs
    ? round((nativeSourceBytes * 8) / (nativeSourceRangeElapsedMs / 1000) / 1_000_000)
    : 0;

  return {
    ranges,
    outcomes,
    segments,
    bytesFromConnector,
    bytesToConsumer,
    bytesDiscarded,
    discardedPercent: bytesFromConnector
      ? round(bytesDiscarded / bytesFromConnector * 100)
      : 0,
    nativeSource: {
      ranges: nativeSourceRanges,
      bytes: nativeSourceBytes,
      averageRangeMs: nativeSourceAverageRangeMs,
      maxRangeMs: nativeSourceRangeMaxMs,
      throughputMbps: nativeSourceThroughputMbps,
      seeks: nativeSourceSeeks,
      cacheSeekHits: nativeSourceCacheSeekHits,
      errors: nativeSourceErrors,
      maxGeneration: nativeSourceMaxGeneration,
      rangeSizes: Object.fromEntries([...nativeRangeSizes.entries()].sort((a, b) => a[0] - b[0])),
      poolSlots: Object.fromEntries([...nativePoolSlots.entries()].sort((a, b) => a[0] - b[0])),
      close: nativeClose,
    },
  };
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function renderReport(connector, client) {
  const lines = [
    'BAIA native-player PoC log summary',
    '',
    `Media requests: ${connector.mediaRequests}`,
    `Distinct TLS connections: ${connector.distinctTlsConnections}`,
    `Reused requests: ${connector.reusedRequests} (${connector.reusePercent}%)`,
    `Max request index on connection: ${connector.maxRequestIndexOnConnection}`,
    `Broken pipe lines: ${connector.brokenPipes}`,
    '',
    `Direct-file requests: ${connector.directFile.requests}`,
    `Direct-file GET requests: ${connector.directFile.getRequests}`,
    `Direct-file requested: ${formatBytes(connector.directFile.requestedBytes)}`,
    `Direct-file streamed: ${formatBytes(connector.directFile.bytesStreamed)} (${connector.directFile.completionPercent}%)`,
    `Direct-file zero-byte GETs: ${connector.directFile.zeroByteGets}`,
    `Direct-file client disconnects: ${connector.directFile.clientDisconnects}`,
    `Direct-file avg control: ${connector.directFile.averageControlMs} ms`,
    `Direct-file avg elapsed: ${connector.directFile.averageElapsedMs} ms`,
    `Direct-file max elapsed: ${connector.directFile.maxElapsedMs} ms`,
  ];
  if (client) {
    lines.push(
      '',
      `Video ranges observed: ${client.ranges}`,
      `Range outcomes: complete=${client.outcomes.complete}, superseded=${client.outcomes.superseded}, client_disconnected=${client.outcomes.client_disconnected}, other=${client.outcomes.other}`,
      `Segments: ${client.segments}`,
      `Bytes from Connector: ${formatBytes(client.bytesFromConnector)}`,
      `Bytes to consumer: ${formatBytes(client.bytesToConsumer)}`,
      `Bytes discarded: ${formatBytes(client.bytesDiscarded)} (${client.discardedPercent}%)`,
      '',
      `Native source ranges: ${client.nativeSource.ranges}`,
      `Native source bytes: ${formatBytes(client.nativeSource.bytes)}`,
      `Native source average range: ${client.nativeSource.averageRangeMs} ms`,
      `Native source max range: ${client.nativeSource.maxRangeMs} ms`,
      `Native source measured throughput: ${client.nativeSource.throughputMbps} Mbps`,
      `Native source seeks: ${client.nativeSource.seeks} (cache hits=${client.nativeSource.cacheSeekHits})`,
      `Native source max generation: ${client.nativeSource.maxGeneration}`,
      `Native source range sizes: ${JSON.stringify(client.nativeSource.rangeSizes)}`,
      `Native source pool slots: ${JSON.stringify(client.nativeSource.poolSlots)}`,
      `Native source errors: ${client.nativeSource.errors}`,
    );
    if (client.nativeSource.close) {
      lines.push(
        `Native source close bytes served to mpv: ${formatBytes(client.nativeSource.close.bytesServedToMpv)}`,
        `Native source close cache hits/misses: ${client.nativeSource.close.cacheHits}/${client.nativeSource.close.cacheMisses}`,
      );
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const [, , connectorPath, clientPath, ...rest] = argv;
  if (!connectorPath || rest.length) {
    console.error('Uso: node scripts/analyze-native-player-poc.js <connector.log> [client.log]');
    process.exitCode = 2;
    return;
  }
  const connectorText = fs.readFileSync(path.resolve(connectorPath), 'utf8');
  const clientText = clientPath ? fs.readFileSync(path.resolve(clientPath), 'utf8') : null;
  const connector = parseConnectorLog(connectorText);
  const client = clientText == null ? null : parseClientLog(clientText);
  console.log(renderReport(connector, client));
  console.log('\nJSON');
  console.log(JSON.stringify({ connector, client }, null, 2));
}

if (require.main === module) main(process.argv);

module.exports = { parseConnectorLog, parseClientLog, renderReport };
