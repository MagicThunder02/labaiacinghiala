'use strict';

const fs = require('node:fs');
const express = require('express');
const { getProfileKey } = require('../utils/profile-key');
const {
  getMusicAlbum,
  getMusicArtist,
  getMusicFilters,
  getMusicHome,
  getMusicTrack,
  listMusicAlbums,
  listMusicArtists,
  listMusicTracks,
  searchMusicCatalog,
} = require('../services/music-catalog-service');
const { getMusicAlbumCover } = require('../services/music-cover-service');
const {
  setMusicAlbumFavorite,
  setMusicTrackFavorite,
} = require('../services/music-favorite-service');
const {
  MusicListeningError,
  recordMusicListening,
} = require('../services/music-listening-service');
const {
  MusicPlaylistError,
  addMusicPlaylistTracks,
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylist,
  listMusicPlaylists,
  removeMusicPlaylistTrack,
  reorderMusicPlaylistTracks,
  updateMusicPlaylist,
} = require('../services/music-playlist-service');
const { sendMusicTrackStream } = require('../services/music-stream-service');

const router = express.Router();

router.get('/home', (req, res) => {
  res.json(getMusicHome(getProfileKey(req)));
});

router.get('/filters', (req, res) => {
  res.json(getMusicFilters(getProfileKey(req)));
});

router.get('/search', (req, res) => {
  res.json(searchMusicCatalog(getProfileKey(req), req.query));
});

function sendPlaylistError(res, error) {
  if (error instanceof MusicPlaylistError || error.statusCode) {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      code: error.code || 'MUSIC_PLAYLIST_ERROR',
    });
  }
  throw error;
}

router.get('/playlists', (req, res) => {
  res.json(listMusicPlaylists(getProfileKey(req)));
});

router.post('/playlists', (req, res) => {
  try {
    return res.status(201).json(createMusicPlaylist(getProfileKey(req), req.body));
  } catch (error) {
    return sendPlaylistError(res, error);
  }
});

router.get('/playlists/:playlistId', (req, res) => {
  const result = getMusicPlaylist(getProfileKey(req), req.params.playlistId);
  if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
  return res.json(result);
});

router.put('/playlists/:playlistId', (req, res) => {
  try {
    const result = updateMusicPlaylist(
      getProfileKey(req),
      req.params.playlistId,
      req.body,
    );
    if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
    return res.json(result);
  } catch (error) {
    return sendPlaylistError(res, error);
  }
});

router.post('/playlists/:playlistId/delete', (req, res) => {
  const result = deleteMusicPlaylist(getProfileKey(req), req.params.playlistId);
  if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
  return res.json(result);
});

router.post('/playlists/:playlistId/tracks', (req, res) => {
  try {
    const result = addMusicPlaylistTracks(
      getProfileKey(req),
      req.params.playlistId,
      req.body?.trackIds,
    );
    if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
    return res.json(result);
  } catch (error) {
    return sendPlaylistError(res, error);
  }
});

router.post('/playlists/:playlistId/tracks/:trackId/remove', (req, res) => {
  try {
    const result = removeMusicPlaylistTrack(
      getProfileKey(req),
      req.params.playlistId,
      req.params.trackId,
    );
    if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
    return res.json(result);
  } catch (error) {
    return sendPlaylistError(res, error);
  }
});

router.put('/playlists/:playlistId/tracks/order', (req, res) => {
  try {
    const result = reorderMusicPlaylistTracks(
      getProfileKey(req),
      req.params.playlistId,
      req.body?.trackIds,
    );
    if (!result) return res.status(404).json({ error: 'Playlist non trovata.' });
    return res.json(result);
  } catch (error) {
    return sendPlaylistError(res, error);
  }
});

router.get('/albums', (req, res) => {
  res.json(listMusicAlbums(getProfileKey(req), req.query));
});


router.get('/albums/:albumId/cover', async (req, res, next) => {
  try {
    const cover = await getMusicAlbumCover(req.params.albumId);
    if (!cover) return res.status(404).end();

    const etag = `W/\"${cover.size}-${cover.modifiedAtMs}\"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.set({
      'Content-Type': cover.mimeType,
      'Content-Length': String(cover.size),
      'Cache-Control': 'private, max-age=86400',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(cover.filePath).on('error', next).pipe(res);
  } catch (error) {
    return next(error);
  }
});

router.put('/albums/:albumId/favorite', (req, res) => {
  if (typeof req.body?.favorite !== 'boolean') {
    return res.status(400).json({ error: 'Il campo favorite deve essere booleano.' });
  }
  const result = setMusicAlbumFavorite(getProfileKey(req), req.params.albumId, req.body.favorite);
  if (!result) return res.status(404).json({ error: 'Album non trovato.' });
  return res.json(result);
});

router.get('/albums/:albumId', (req, res) => {
  const result = getMusicAlbum(getProfileKey(req), req.params.albumId, req.query);
  if (!result) return res.status(404).json({ error: 'Album non trovato.' });
  return res.json(result);
});

router.get('/artists', (req, res) => {
  res.json(listMusicArtists(getProfileKey(req), req.query));
});

router.get('/artists/:artistId', (req, res) => {
  const result = getMusicArtist(getProfileKey(req), req.params.artistId);
  if (!result) return res.status(404).json({ error: 'Artista non trovato.' });
  return res.json(result);
});

router.get('/tracks', (req, res) => {
  res.json(listMusicTracks(getProfileKey(req), req.query));
});

router.get('/tracks/:trackId/stream', (req, res, next) => (
  sendMusicTrackStream(req, res, next, req.params.trackId)
));

router.put('/tracks/:trackId/listening', (req, res) => {
  try {
    const result = recordMusicListening(
      getProfileKey(req),
      req.params.trackId,
      req.body,
    );
    if (!result) return res.status(404).json({ error: 'Brano non trovato.' });
    return res.json({ listening: result });
  } catch (error) {
    if (error instanceof MusicListeningError || error.statusCode) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        code: error.code || 'MUSIC_LISTENING_ERROR',
      });
    }
    throw error;
  }
});

router.put('/tracks/:trackId/favorite', (req, res) => {
  if (typeof req.body?.favorite !== 'boolean') {
    return res.status(400).json({ error: 'Il campo favorite deve essere booleano.' });
  }
  const result = setMusicTrackFavorite(getProfileKey(req), req.params.trackId, req.body.favorite);
  if (!result) return res.status(404).json({ error: 'Brano non trovato.' });
  return res.json(result);
});

router.get('/tracks/:trackId', (req, res) => {
  const track = getMusicTrack(getProfileKey(req), req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Brano non trovato.' });
  return res.json({ track });
});

module.exports = router;
