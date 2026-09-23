#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseConnectorLog(text) {
  const connections = new Set();
  let mediaRequests = 0;
  let reused = 0;
  let maxRequestIndex = 0;
  let brokenPipes = 0;

  for (const line of String(text).split(/\r?\n/)) {
    if (/broken pipe/i.test(line)) brokenPipes += 1;
    const match = line.match(/connector_connection_id=([^\s]+)\s+request_index_on_connection=(\d+)\s+transport_reused=(true|false)\s+route=([^\s]+)/);
    if (!match || match[4] !== '/baia/v1/media') continue;
    mediaRequests += 1;
    connections.add(match[1]);
    if (match[3] === 'true') reused += 1;
    maxRequestIndex = Math.max(maxRequestIndex, Number(match[2]));
  }

  return {
    mediaRequests,
    distinctTlsConnections: connections.size,
    reusedRequests: reused,
    reusePercent: mediaRequests ? Number((reused / mediaRequests * 100).toFixed(2)) : 0,
    maxRequestIndexOnConnection: maxRequestIndex,
    brokenPipes,
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
  let nativeSourceErrors = 0;

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

    const nativeRange = line.match(/native_media_source\s+event=range\s+start=(\d+)\s+end=(\d+)\s+bytes=(\d+)\s+elapsed_ms=(\d+)/);
    if (nativeRange) {
      const bytes = Number(nativeRange[3]);
      const elapsed = Number(nativeRange[4]);
      nativeSourceRanges += 1;
      nativeSourceBytes += bytes;
      nativeSourceRangeElapsedMs += elapsed;
      nativeSourceRangeMaxMs = Math.max(nativeSourceRangeMaxMs, elapsed);
      continue;
    }
    if (/native_media_source\s+event=seek\b/.test(line)) nativeSourceSeeks += 1;
    if (/native_media_source\s+event=(?:read_error|seek_error|open_error)\b/.test(line)) nativeSourceErrors += 1;
  }

  const nativeSourceAverageRangeMs = nativeSourceRanges
    ? Number((nativeSourceRangeElapsedMs / nativeSourceRanges).toFixed(2))
    : 0;
  const nativeSourceThroughputMbps = nativeSourceRangeElapsedMs
    ? Number(((nativeSourceBytes * 8) / (nativeSourceRangeElapsedMs / 1000) / 1_000_000).toFixed(2))
    : 0;

  return {
    ranges,
    outcomes,
    segments,
    bytesFromConnector,
    bytesToConsumer,
    bytesDiscarded,
    discardedPercent: bytesFromConnector
      ? Number((bytesDiscarded / bytesFromConnector * 100).toFixed(2))
      : 0,
    nativeSource: {
      ranges: nativeSourceRanges,
      bytes: nativeSourceBytes,
      averageRangeMs: nativeSourceAverageRangeMs,
      maxRangeMs: nativeSourceRangeMaxMs,
      throughputMbps: nativeSourceThroughputMbps,
      seeks: nativeSourceSeeks,
      errors: nativeSourceErrors,
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
      `Native source seeks: ${client.nativeSource.seeks}`,
      `Native source errors: ${client.nativeSource.errors}`,
    );
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
