'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MODES, normalizeTrack, createPlayerState } = require('../public/js/music-player-state');

function track(id) {
  return {
    trackId: `123e4567-e89b-42d3-a456-42661417400${id}`,
    title: `Brano ${id}`,
    artists: [{ artistId: null, name: 'Artista' }],
    albumId: '223e4567-e89b-42d3-a456-426614174000',
    albumTitle: 'Album',
    coverUrl: '/api/music/albums/223e4567-e89b-42d3-a456-426614174000/cover',
    streamUrl: `/api/music/tracks/123e4567-e89b-42d3-a456-42661417400${id}/stream`,
    durationSeconds: 180,
  };
}

test('stato player accetta soltanto brani con endpoint musicale logico', () => {
  assert.equal(normalizeTrack(track(1)).title, 'Brano 1');
  assert.equal(normalizeTrack({ ...track(1), streamUrl: 'C:\\Musica\\brano.mp3' }), null);
  assert.equal(normalizeTrack({ ...track(1), streamUrl: '/api/movies/1/stream' }), null);
});

test('coda seleziona il brano richiesto, elimina duplicati e conserva il contesto', () => {
  const player = createPlayerState();
  const current = player.setQueue([track(1), track(2), track(2), null], {
    startTrackId: track(2).trackId,
    queueContext: { type: 'album', id: 'album-id', title: 'Album' },
  });
  const snapshot = player.snapshot();
  assert.equal(current.trackId, track(2).trackId);
  assert.equal(snapshot.queueLength, 2);
  assert.equal(snapshot.queueIndex, 1);
  assert.deepEqual(snapshot.context, { type: 'album', id: 'album-id', title: 'Album' });
});

test('modalità seguono il ciclo Normale Shuffle Ripeti Ripeti 1', () => {
  const player = createPlayerState();
  player.setQueue([track(1)]);
  assert.deepEqual(MODES, ['normal', 'shuffle', 'repeat', 'repeat-one']);
  assert.equal(player.snapshot().mode, 'normal');
  assert.equal(player.cycleMode(), 'shuffle');
  assert.equal(player.cycleMode(), 'repeat');
  assert.equal(player.cycleMode(), 'repeat-one');
  assert.equal(player.cycleMode(), 'normal');
});

test('Normale si ferma alla fine mentre Ripeti ricomincia la coda', () => {
  const player = createPlayerState();
  player.setQueue([track(1), track(2)], { startTrackId: track(2).trackId });
  assert.equal(player.next({ automatic: true }), null);
  player.setMode('repeat');
  const result = player.next({ automatic: true });
  assert.equal(result.track.trackId, track(1).trackId);
  assert.equal(result.replay, false);
});

test('Ripeti 1 ripete automaticamente il brano ma il comando avanti resta manuale', () => {
  const player = createPlayerState();
  player.setQueue([track(1), track(2)]);
  player.setMode('repeat-one');
  const automatic = player.next({ automatic: true });
  assert.equal(automatic.track.trackId, track(1).trackId);
  assert.equal(automatic.replay, true);
  const manual = player.next();
  assert.equal(manual.track.trackId, track(2).trackId);
  assert.equal(manual.replay, false);
});

test('Shuffle conserva il brano corrente e visita ogni elemento una volta', () => {
  const values = [0.8, 0.1, 0.6];
  let index = 0;
  const player = createPlayerState({ random: () => values[index++ % values.length] });
  player.setQueue([track(1), track(2), track(3), track(4)], { startTrackId: track(2).trackId });
  player.setMode('shuffle');
  const visited = [player.currentTrack().trackId];
  while (true) {
    const result = player.next();
    if (!result) break;
    visited.push(result.track.trackId);
  }
  assert.equal(visited[0], track(2).trackId);
  assert.equal(new Set(visited).size, 4);
  assert.deepEqual(new Set(visited), new Set([track(1), track(2), track(3), track(4)].map((item) => item.trackId)));
});

test('snapshot espone la coda ordinata e consente di selezionare un brano dalla coda', () => {
  const player = createPlayerState();
  player.setQueue([track(1), track(2), track(3)], { startTrackId: track(1).trackId });
  const selected = player.selectTrack(track(3).trackId);
  assert.equal(selected.track.trackId, track(3).trackId);
  assert.equal(selected.changed, true);
  const snapshot = player.snapshot();
  assert.equal(snapshot.queue.length, 3);
  assert.equal(snapshot.queue.filter((item) => item.active).length, 1);
  assert.equal(snapshot.queue.find((item) => item.active).trackId, track(3).trackId);
  assert.equal(player.selectTrack('inesistente'), null);
});


test('aggiunge brani in fondo senza duplicati e seleziona il primo soltanto a coda vuota', () => {
  const player = createPlayerState();
  const first = player.appendTracks([track(1), track(2), track(1)]);
  assert.equal(first.addedCount, 2);
  assert.equal(first.selectedFirstTrack, true);
  assert.equal(player.currentTrack().trackId, track(1).trackId);
  const second = player.appendTracks([track(3), track(2)]);
  assert.equal(second.addedCount, 1);
  assert.deepEqual(player.snapshot().queue.map((item) => item.trackId), [track(1), track(2), track(3)].map((item) => item.trackId));
});

test('riordino manuale conserva il brano corrente e disattiva Shuffle', () => {
  const player = createPlayerState({ random: () => 0.8 });
  player.setQueue([track(1), track(2), track(3)], { startTrackId: track(2).trackId });
  player.setMode('shuffle');
  const result = player.moveTrack(track(3).trackId, 0);
  assert.equal(result.changed, true);
  assert.equal(result.modeChanged, true);
  assert.equal(player.snapshot().mode, 'normal');
  assert.equal(player.currentTrack().trackId, track(2).trackId);
  assert.equal(player.snapshot().queue[0].trackId, track(3).trackId);
});

test('rimozione del brano corrente seleziona il successivo e si ferma solo a coda vuota', () => {
  const player = createPlayerState();
  player.setQueue([track(1), track(2), track(3)], { startTrackId: track(2).trackId });
  const middle = player.removeTrack(track(2).trackId);
  assert.equal(middle.wasCurrent, true);
  assert.equal(middle.nextTrack.trackId, track(3).trackId);
  const lastPosition = player.removeTrack(track(3).trackId);
  assert.equal(lastPosition.wasCurrent, true);
  assert.equal(lastPosition.hadNext, false);
  assert.equal(lastPosition.nextTrack.trackId, track(1).trackId);
  const empty = player.removeTrack(track(1).trackId);
  assert.equal(empty.queueEmpty, true);
  assert.equal(player.currentTrack(), null);
});

test('svuotamento manuale elimina coda e selezione corrente', () => {
  const player = createPlayerState();
  player.setQueue([track(1), track(2)]);
  assert.equal(player.clearQueue(), 2);
  assert.equal(player.snapshot().queueLength, 0);
  assert.equal(player.currentTrack(), null);
});
