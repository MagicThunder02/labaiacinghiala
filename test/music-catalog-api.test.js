'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'music.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('catalogo musica espone API additive dietro autenticazione account e permesso Musica', () => {
  for (const endpoint of [
    '/home',
    '/filters',
    '/search',
    '/albums',
    '/albums/:albumId',
    '/albums/:albumId/cover',
    '/artists',
    '/artists/:artistId',
    '/tracks',
    '/tracks/:trackId',
    '/tracks/:trackId/stream',
    '/playlists',
    '/playlists/:playlistId',
  ]) {
    assert.match(routeSource, new RegExp(`router\\.get\\('${endpoint.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
  }
  assert.match(routeSource, /router\.put\('\/albums\/:albumId\/favorite'/);
  assert.match(routeSource, /router\.put\('\/tracks\/:trackId\/favorite'/);
  assert.match(routeSource, /router\.put\('\/tracks\/:trackId\/listening'/);
  assert.match(routeSource, /router\.post\('\/playlists'/);
  assert.match(routeSource, /router\.put\('\/playlists\/:playlistId'/);
  assert.match(routeSource, /router\.post\('\/playlists\/:playlistId\/delete'/);
  assert.match(routeSource, /router\.post\('\/playlists\/:playlistId\/tracks'/);
  assert.match(routeSource, /router\.post\('\/playlists\/:playlistId\/tracks\/:trackId\/remove'/);
  assert.match(routeSource, /router\.put\('\/playlists\/:playlistId\/tracks\/order'/);
  assert.doesNotMatch(routeSource, /router\.(?:patch|delete)\(/);

  const accountPosition = serverSource.indexOf("app.use('/api', createAccountAuth");
  const musicPosition = serverSource.indexOf("app.use('/api/music', requireSection('music'), musicRouter)");
  assert.ok(accountPosition >= 0 && musicPosition > accountPosition);
});
