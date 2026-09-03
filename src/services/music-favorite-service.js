'use strict';

const db = require('../database');

const findTrack = db.prepare(`
  SELECT id, track_uuid AS trackId, album_id AS albumInternalId
  FROM music_tracks
  WHERE track_uuid = ? AND available = 1
`);

const findAlbum = db.prepare(`
  SELECT id, album_uuid AS albumId
  FROM music_albums
  WHERE album_uuid = ?
`);

const findAlbumByInternalId = db.prepare(`
  SELECT album_uuid AS albumId
  FROM music_albums
  WHERE id = ?
`);

const addTrackFavorite = db.prepare(`
  INSERT OR IGNORE INTO music_track_favorites (track_id, profile_key)
  VALUES (?, ?)
`);

const removeTrackFavorite = db.prepare(`
  DELETE FROM music_track_favorites
  WHERE track_id = ? AND profile_key = ?
`);

const addAlbumFavorites = db.prepare(`
  INSERT OR IGNORE INTO music_track_favorites (track_id, profile_key)
  SELECT id, ?
  FROM music_tracks
  WHERE album_id = ? AND available = 1
`);

const removeAlbumFavorites = db.prepare(`
  DELETE FROM music_track_favorites
  WHERE profile_key = ?
    AND track_id IN (
      SELECT id
      FROM music_tracks
      WHERE album_id = ?
    )
`);

const getAlbumFavoriteState = db.prepare(`
  SELECT
    COUNT(t.id) AS trackCount,
    COUNT(f.track_id) AS favoriteTrackCount
  FROM music_tracks t
  LEFT JOIN music_track_favorites f
    ON f.track_id = t.id AND f.profile_key = ?
  WHERE t.album_id = ? AND t.available = 1
`);

function normalizeProfileKey(profileKey) {
  return String(profileKey || 'default').trim() || 'default';
}

function setMusicTrackFavorite(profileKey, trackId, favorite) {
  const track = findTrack.get(String(trackId || '').trim());
  if (!track) return null;

  const normalizedProfileKey = normalizeProfileKey(profileKey);
  if (favorite) addTrackFavorite.run(track.id, normalizedProfileKey);
  else removeTrackFavorite.run(track.id, normalizedProfileKey);

  const state = getAlbumFavoriteState.get(normalizedProfileKey, track.albumInternalId);
  const album = findAlbumByInternalId.get(track.albumInternalId);
  const trackCount = Number(state?.trackCount || 0);
  const favoriteTrackCount = Number(state?.favoriteTrackCount || 0);

  return {
    trackId: track.trackId,
    favorite: Boolean(favorite),
    album: {
      albumId: album.albumId,
      favorite: favoriteTrackCount > 0,
      fullyFavorite: trackCount > 0 && favoriteTrackCount === trackCount,
      favoriteTrackCount,
      trackCount,
    },
  };
}

function updateAlbumFavorites(profileKey, albumInternalId, favorite) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (favorite) addAlbumFavorites.run(profileKey, albumInternalId);
    else removeAlbumFavorites.run(profileKey, albumInternalId);
    const state = getAlbumFavoriteState.get(profileKey, albumInternalId);
    db.exec('COMMIT');
    return state;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function setMusicAlbumFavorite(profileKey, albumId, favorite) {
  const album = findAlbum.get(String(albumId || '').trim());
  if (!album) return null;

  const normalizedProfileKey = normalizeProfileKey(profileKey);
  const state = updateAlbumFavorites(normalizedProfileKey, album.id, Boolean(favorite));
  const trackCount = Number(state?.trackCount || 0);
  const favoriteTrackCount = Number(state?.favoriteTrackCount || 0);

  return {
    albumId: album.albumId,
    favorite: favoriteTrackCount > 0,
    fullyFavorite: trackCount > 0 && favoriteTrackCount === trackCount,
    favoriteTrackCount,
    trackCount,
  };
}

module.exports = {
  setMusicAlbumFavorite,
  setMusicTrackFavorite,
};
