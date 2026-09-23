const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConnectorLog, parseClientLog } = require('../scripts/analyze-native-player-poc');

test('analizzatore PoC misura il riuso TLS solo sul canale media', () => {
  const parsed = parseConnectorLog(`
connector_connection_id=a request_index_on_connection=1 transport_reused=false route=/baia/v1/media
connector_connection_id=a request_index_on_connection=2 transport_reused=true route=/baia/v1/media
connector_connection_id=b request_index_on_connection=1 transport_reused=false route=/baia/v1/request
connector_connection_id=c request_index_on_connection=1 transport_reused=false route=/baia/v1/media
Richiesta Host Connector rifiutata o interrotta: Broken pipe
`);
  assert.equal(parsed.mediaRequests, 3);
  assert.equal(parsed.distinctTlsConnections, 2);
  assert.equal(parsed.reusedRequests, 1);
  assert.equal(parsed.reusePercent, 33.33);
  assert.equal(parsed.maxRequestIndexOnConnection, 2);
  assert.equal(parsed.brokenPipes, 1);
});

test('analizzatore PoC misura direct-file completion, disconnect e control latency', () => {
  const parsed = parseConnectorLog([
    'media=x media_source=direct_file method=HEAD requested_start=0 requested_end=999 requested_bytes=1000 bytes_streamed=0 client_disconnected=false status=200 control_elapsed_ms=4 elapsed_ms=5',
    'media=y media_source=direct_file method=GET requested_start=0 requested_end=1048575 requested_bytes=1048576 bytes_streamed=1048576 client_disconnected=false status=206 control_elapsed_ms=10 elapsed_ms=900',
    'media=z media_source=direct_file method=GET requested_start=1048576 requested_end=2097151 requested_bytes=1048576 bytes_streamed=0 client_disconnected=true status=206 control_elapsed_ms=20 elapsed_ms=100',
  ].join('\n'));

  assert.equal(parsed.directFile.requests, 3);
  assert.equal(parsed.directFile.getRequests, 2);
  assert.equal(parsed.directFile.requestedBytes, 2097152);
  assert.equal(parsed.directFile.bytesStreamed, 1048576);
  assert.equal(parsed.directFile.completionPercent, 50);
  assert.equal(parsed.directFile.zeroByteGets, 1);
  assert.equal(parsed.directFile.clientDisconnects, 1);
  assert.equal(parsed.directFile.averageControlMs, 15);
  assert.equal(parsed.directFile.averageElapsedMs, 500);
  assert.equal(parsed.directFile.maxElapsedMs, 900);
});

test('analizzatore PoC riassume outcome e overfetch del Media Bridge', () => {
  const parsed = parseClientLog(`
video_range_id=r1 event=end result=complete requested_start=0 requested_end=99 segment_count=1 bytes_from_connector=100 bytes_to_webview=100 bytes_discarded=0
video_range_id=r2 event=end result=superseded requested_start=100 requested_end=open segment_count=2 bytes_from_connector=80 bytes_to_webview=60 bytes_discarded=20
`);
  assert.equal(parsed.ranges, 2);
  assert.deepEqual(parsed.outcomes, { complete: 1, superseded: 1, client_disconnected: 0, other: 0 });
  assert.equal(parsed.segments, 3);
  assert.equal(parsed.bytesFromConnector, 180);
  assert.equal(parsed.bytesToConsumer, 160);
  assert.equal(parsed.bytesDiscarded, 20);
  assert.equal(parsed.discardedPercent, 11.11);
});

test('analizzatore PoC misura Range adattivi, pool e seek cache della NativeMediaSource', () => {
  const parsed = parseClientLog([
    'native_media_source event=seek offset=0 cache_hit=false generation=1 next_range_bytes=1048576',
    'native_media_source event=range generation=1 pool_slot=0 requested_start=0 requested_end=1048575 requested_bytes=1048576 bytes_received=1048576 elapsed_ms=1000 sequential_fetches=1 cache_start=0 cache_end=1048576 cache_window_bytes=1048576',
    'native_media_source event=range generation=1 pool_slot=1 requested_start=1048576 requested_end=3145727 requested_bytes=2097152 bytes_received=2097152 elapsed_ms=1500 sequential_fetches=2 cache_start=0 cache_end=3145728 cache_window_bytes=3145728',
    'native_media_source event=seek offset=1000 cache_hit=true generation=1 next_range_bytes=4194304',
    'native_media_source event=read_error error=test',
    'native_media_source event=close remote_requests=2 bytes_requested=3145728 bytes_received=3145728 bytes_served_to_mpv=2000000 cache_hits=10 cache_misses=2 cache_seek_hits=1 seeks=2 errors=1 generation=1 pool_slot_0_requests=1 pool_slot_1_requests=1',
  ].join('\n'));

  assert.equal(parsed.nativeSource.ranges, 2);
  assert.equal(parsed.nativeSource.bytes, 3145728);
  assert.equal(parsed.nativeSource.averageRangeMs, 1250);
  assert.equal(parsed.nativeSource.maxRangeMs, 1500);
  assert.equal(parsed.nativeSource.seeks, 2);
  assert.equal(parsed.nativeSource.cacheSeekHits, 1);
  assert.equal(parsed.nativeSource.errors, 1);
  assert.equal(parsed.nativeSource.maxGeneration, 1);
  assert.deepEqual(parsed.nativeSource.rangeSizes, { 1048576: 1, 2097152: 1 });
  assert.deepEqual(parsed.nativeSource.poolSlots, { 0: 1, 1: 1 });
  assert.equal(parsed.nativeSource.close.bytesServedToMpv, 2000000);
  assert.ok(parsed.nativeSource.throughputMbps > 0);
});

test('analizzatore mantiene compatibilità con log Phase 3', () => {
  const parsed = parseClientLog([
    'native_media_source event=range start=0 end=4194303 bytes=4194304 elapsed_ms=1000',
    'native_media_source event=seek offset=500000000',
  ].join('\n'));
  assert.equal(parsed.nativeSource.ranges, 1);
  assert.equal(parsed.nativeSource.bytes, 4194304);
  assert.equal(parsed.nativeSource.seeks, 1);
});
