'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createListeningState } = require('../public/js/music-listening-state');

test('tracker conta soltanto avanzamento audio credibile e ignora i salti di seek', () => {
  let sessionCounter = 0;
  const tracker = createListeningState({
    createSessionId: () => `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, '0')}`,
  });

  tracker.start('track-1', 0, 1000);
  tracker.play(0, 1000);
  tracker.sample(10, 11000);
  assert.equal(tracker.snapshot().listenedSeconds, 10);

  tracker.sample(120, 11500);
  assert.equal(tracker.snapshot().listenedSeconds, 10, 'un salto di seek non deve contare come ascolto');

  tracker.seek(30, 12000);
  tracker.sample(35, 17000);
  assert.equal(tracker.snapshot().listenedSeconds, 15);

  tracker.pause(40, 22000);
  assert.equal(tracker.snapshot().listenedSeconds, 20);
  tracker.sample(50, 32000);
  assert.equal(tracker.snapshot().listenedSeconds, 20, 'il tempo in pausa non deve contare');

  assert.deepEqual(tracker.payload(180, 'pause'), {
    sessionId: '00000000-0000-4000-8000-000000000001',
    event: 'pause',
    positionSeconds: 50,
    durationSeconds: 180,
    listenedSeconds: 20,
  });
});

test('una nuova riproduzione crea una sessione distinta e clear conserva uno snapshot finale', () => {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const tracker = createListeningState({ createSessionId: () => ids.shift() });
  tracker.start('track-1', 0, 1000);
  const first = tracker.clear();
  assert.equal(first.trackId, 'track-1');
  assert.equal(tracker.snapshot(), null);
  tracker.start('track-1', 0, 2000);
  assert.equal(tracker.snapshot().sessionId, '22222222-2222-4222-8222-222222222222');
  assert.equal(tracker.isCurrent('track-1'), true);
});
