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
  assert.deepEqual(parsed, {
    mediaRequests: 3,
    distinctTlsConnections: 2,
    reusedRequests: 1,
    reusePercent: 33.33,
    maxRequestIndexOnConnection: 2,
    brokenPipes: 1,
  });
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

test('analizzatore PoC misura Range e throughput della NativeMediaSource baia://', () => {
  const parsed = parseClientLog([
    'native_media_source event=range start=0 end=4194303 bytes=4194304 elapsed_ms=1000',
    'native_media_source event=seek offset=500000000',
    'native_media_source event=range start=500000000 end=504194303 bytes=4194304 elapsed_ms=2000',
    'native_media_source event=read_error error=test',
  ].join('\n'));

  assert.equal(parsed.nativeSource.ranges, 2);
  assert.equal(parsed.nativeSource.bytes, 8388608);
  assert.equal(parsed.nativeSource.averageRangeMs, 1500);
  assert.equal(parsed.nativeSource.maxRangeMs, 2000);
  assert.equal(parsed.nativeSource.seeks, 1);
  assert.equal(parsed.nativeSource.errors, 1);
  assert.ok(parsed.nativeSource.throughputMbps > 0);
});
