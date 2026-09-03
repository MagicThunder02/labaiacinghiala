'use strict';

const crypto = require('node:crypto');
const db = require('../database');
const { normalizeProfileKey } = require('../utils/profile-key');
const { getMusicTracksByIds } = require('./music-catalog-service');

const MAX_PLAYLIST_NAME_LENGTH = 100;
const MAX_PLAYLIST_DESCRIPTION_LENGTH = 500;
const MAX_TRACKS_PER_REQUEST = 500;

class MusicPlaylistError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MusicPlaylistError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const listPlaylists = db.prepare(`
  SELECT
    p.id AS internalId,
    p.playlist_uuid AS playlistId,
    p.name,
    p.description,
    p.created_at AS createdAt,
    p.updated_at AS updatedAt,
    COUNT(pt.track_id) AS trackCount,
    COUNT(CASE WHEN t.available = 1 THEN 1 END) AS availableTrackCount,
    COALESCE(SUM(CASE WHEN t.available = 1 THEN t.duration_seconds ELSE 0 END), 0) AS durationSeconds
  FROM music_playlists p
  LEFT JOIN music_playlist_tracks pt ON pt.playlist_id = p.id
  LEFT JOIN music_tracks t ON t.id = pt.track_id
  WHERE p.profile_key = ?
  GROUP BY p.id
  ORDER BY p.updated_at DESC, p.name COLLATE NOCASE ASC
`);

const listPlaylistCoverAlbums = db.prepare(`
  SELECT
    p.id AS internalId,
    a.album_uuid AS albumId,
    a.updated_at AS albumUpdatedAt,
    MIN(pt.position) AS firstPosition
  FROM music_playlists p
  JOIN music_playlist_tracks pt ON pt.playlist_id = p.id
  JOIN music_tracks t ON t.id = pt.track_id AND t.available = 1
  JOIN music_albums a ON a.id = t.album_id
  WHERE p.profile_key = ?
    AND (
      a.cover_cache_path IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM music_tracks cover_track
        WHERE cover_track.album_id = a.id
          AND cover_track.available = 1
          AND cover_track.has_cover_art = 1
      )
    )
  GROUP BY p.id, a.id
  ORDER BY p.id ASC, firstPosition ASC, a.title COLLATE NOCASE ASC
`);

const findPlaylist = db.prepare(`
  SELECT id AS internalId, playlist_uuid AS playlistId, profile_key AS profileKey,
         name, description, created_at AS createdAt, updated_at AS updatedAt
  FROM music_playlists
  WHERE profile_key = ? AND playlist_uuid = ?
  LIMIT 1
`);

const insertPlaylist = db.prepare(`
  INSERT INTO music_playlists (playlist_uuid, profile_key, name, description, updated_at)
  VALUES (?, ?, ?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const updatePlaylist = db.prepare(`
  UPDATE music_playlists
  SET name = ?, description = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const touchPlaylist = db.prepare(`
  UPDATE music_playlists
  SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

const deletePlaylist = db.prepare(`
  DELETE FROM music_playlists
  WHERE id = ?
`);

const listPlaylistTrackRows = db.prepare(`
  SELECT pt.track_id AS internalTrackId, t.track_uuid AS trackId, pt.position,
         pt.added_at AS addedAt, t.available
  FROM music_playlist_tracks pt
  JOIN music_tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ?
  ORDER BY pt.position ASC
`);

const findAvailableTrackByUuid = db.prepare(`
  SELECT id AS internalId, track_uuid AS trackId
  FROM music_tracks
  WHERE track_uuid = ? AND available = 1
  LIMIT 1
`);

const findPlaylistTrack = db.prepare(`
  SELECT pt.track_id AS internalTrackId, t.track_uuid AS trackId, pt.position
  FROM music_playlist_tracks pt
  JOIN music_tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ? AND t.track_uuid = ?
  LIMIT 1
`);

const insertPlaylistTrack = db.prepare(`
  INSERT OR IGNORE INTO music_playlist_tracks (playlist_id, track_id, position)
  VALUES (?, ?, ?)
`);

const removePlaylistTrack = db.prepare(`
  DELETE FROM music_playlist_tracks
  WHERE playlist_id = ? AND track_id = ?
`);

const offsetPlaylistPositions = db.prepare(`
  UPDATE music_playlist_tracks
  SET position = position + 1000000
  WHERE playlist_id = ?
`);

const setPlaylistTrackPosition = db.prepare(`
  UPDATE music_playlist_tracks
  SET position = ?
  WHERE playlist_id = ? AND track_id = ?
`);

function normalizeText(value, maximum, fieldName, { required = false } = {}) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !text) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_INVALID_NAME',
      `${fieldName} è obbligatorio.`,
    );
  }
  if (text.length > maximum) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_FIELD_TOO_LONG',
      `${fieldName} può contenere al massimo ${maximum} caratteri.`,
    );
  }
  return text;
}

function normalizePlaylistInput(payload = {}, current = null) {
  const hasName = Object.hasOwn(payload || {}, 'name');
  const hasDescription = Object.hasOwn(payload || {}, 'description');
  const name = normalizeText(
    hasName ? payload.name : current?.name,
    MAX_PLAYLIST_NAME_LENGTH,
    'Il nome della playlist',
    { required: true },
  );
  const description = normalizeText(
    hasDescription ? payload.description : current?.description,
    MAX_PLAYLIST_DESCRIPTION_LENGTH,
    'La descrizione',
  );
  return { name, description };
}

function normalizeTrackIds(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_INVALID_TRACKS',
      'trackIds deve essere un elenco di brani.',
    );
  }
  if (value.length > MAX_TRACKS_PER_REQUEST) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_TOO_MANY_TRACKS',
      `È possibile modificare al massimo ${MAX_TRACKS_PER_REQUEST} brani per richiesta.`,
    );
  }
  const result = [];
  const seen = new Set();
  for (const rawValue of value) {
    const trackId = String(rawValue || '').trim();
    if (!trackId || trackId.length > 128) {
      throw new MusicPlaylistError(
        'MUSIC_PLAYLIST_INVALID_TRACK',
        'Uno degli identificatori dei brani non è valido.',
      );
    }
    if (seen.has(trackId)) continue;
    seen.add(trackId);
    result.push(trackId);
  }
  if (!allowEmpty && !result.length) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_EMPTY_TRACKS',
      'Seleziona almeno un brano.',
    );
  }
  return result;
}

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function translateConstraint(error) {
  if (String(error?.message || '').includes('idx_music_playlists_profile_name')
    || String(error?.message || '').includes('music_playlists.profile_key, music_playlists.name')) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_NAME_CONFLICT',
      'Esiste già una playlist con questo nome per il profilo corrente.',
      409,
    );
  }
  throw error;
}

function playlistCoverMap(profileKey) {
  const map = new Map();
  for (const row of listPlaylistCoverAlbums.all(profileKey)) {
    const internalId = Number(row.internalId);
    if (!map.has(internalId)) map.set(internalId, []);
    const covers = map.get(internalId);
    if (covers.length >= 4) continue;
    covers.push(`/api/music/albums/${encodeURIComponent(row.albumId)}/cover?v=${encodeURIComponent(row.albumUpdatedAt || '')}`);
  }
  return map;
}

function serializePlaylist(row, coverUrls = []) {
  return {
    playlistId: row.playlistId,
    name: row.name,
    description: row.description || '',
    trackCount: Number(row.trackCount || 0),
    availableTrackCount: Number(row.availableTrackCount || 0),
    durationSeconds: Number(row.durationSeconds || 0),
    coverUrl: coverUrls[0] || null,
    coverUrls,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function listPlaylistSummaries(profileKey) {
  const coversByPlaylist = playlistCoverMap(profileKey);
  return listPlaylists.all(profileKey)
    .map((row) => serializePlaylist(row, coversByPlaylist.get(Number(row.internalId)) || []));
}

function getPlaylistSummary(profileKey, playlistId) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  return listPlaylistSummaries(normalizedProfile)
    .find((playlist) => playlist.playlistId === playlistId) || null;
}

function listMusicPlaylists(profileKey) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const playlists = listPlaylistSummaries(normalizedProfile);
  return { playlists, count: playlists.length };
}

function getMusicPlaylist(profileKey, playlistId) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const normalizedId = String(playlistId || '').trim();
  const playlistRow = findPlaylist.get(normalizedProfile, normalizedId);
  if (!playlistRow) return null;
  const rows = listPlaylistTrackRows.all(playlistRow.internalId);
  const tracks = getMusicTracksByIds(normalizedProfile, rows.map((row) => row.trackId));
  const positions = new Map(rows.map((row) => [row.trackId, {
    position: Number(row.position),
    addedAt: row.addedAt || null,
  }]));
  return {
    playlist: getPlaylistSummary(normalizedProfile, normalizedId),
    tracks: tracks.map((track) => ({ ...track, playlist: positions.get(track.trackId) })),
    missingTrackCount: rows.length - tracks.length,
  };
}

function createMusicPlaylist(profileKey, payload) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const input = normalizePlaylistInput(payload);
  const playlistId = crypto.randomUUID();
  try {
    insertPlaylist.run(playlistId, normalizedProfile, input.name, input.description);
  } catch (error) {
    translateConstraint(error);
  }
  return getMusicPlaylist(normalizedProfile, playlistId);
}

function updateMusicPlaylist(profileKey, playlistId, payload) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const current = findPlaylist.get(normalizedProfile, String(playlistId || '').trim());
  if (!current) return null;
  const input = normalizePlaylistInput(payload, current);
  try {
    updatePlaylist.run(input.name, input.description, current.internalId);
  } catch (error) {
    translateConstraint(error);
  }
  return getMusicPlaylist(normalizedProfile, current.playlistId);
}

function deleteMusicPlaylist(profileKey, playlistId) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const current = findPlaylist.get(normalizedProfile, String(playlistId || '').trim());
  if (!current) return null;
  deletePlaylist.run(current.internalId);
  return { playlistId: current.playlistId, deleted: true };
}

function resolveAvailableTracks(trackIds) {
  return trackIds.map((trackId) => {
    const track = findAvailableTrackByUuid.get(trackId);
    if (!track) {
      throw new MusicPlaylistError(
        'MUSIC_PLAYLIST_TRACK_NOT_FOUND',
        'Uno dei brani non esiste o non è disponibile.',
        404,
      );
    }
    return track;
  });
}

function compactPlaylistPositions(playlistInternalId, orderedTrackInternalIds) {
  offsetPlaylistPositions.run(playlistInternalId);
  orderedTrackInternalIds.forEach((trackInternalId, position) => {
    setPlaylistTrackPosition.run(position, playlistInternalId, trackInternalId);
  });
}

function addMusicPlaylistTracks(profileKey, playlistId, trackIds) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const playlist = findPlaylist.get(normalizedProfile, String(playlistId || '').trim());
  if (!playlist) return null;
  const normalizedTrackIds = normalizeTrackIds(trackIds);
  const tracks = resolveAvailableTracks(normalizedTrackIds);

  transaction(() => {
    const existingRows = listPlaylistTrackRows.all(playlist.internalId);
    let nextPosition = existingRows.length
      ? Math.max(...existingRows.map((row) => Number(row.position))) + 1
      : 0;
    for (const track of tracks) {
      const result = insertPlaylistTrack.run(playlist.internalId, track.internalId, nextPosition);
      if (Number(result.changes || 0) > 0) nextPosition += 1;
    }
    touchPlaylist.run(playlist.internalId);
  });

  return getMusicPlaylist(normalizedProfile, playlist.playlistId);
}

function removeMusicPlaylistTrack(profileKey, playlistId, trackId) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const playlist = findPlaylist.get(normalizedProfile, String(playlistId || '').trim());
  if (!playlist) return null;
  const current = findPlaylistTrack.get(playlist.internalId, String(trackId || '').trim());
  if (!current) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_TRACK_NOT_IN_PLAYLIST',
      'Il brano non appartiene a questa playlist.',
      404,
    );
  }

  transaction(() => {
    removePlaylistTrack.run(playlist.internalId, current.internalTrackId);
    const remaining = listPlaylistTrackRows.all(playlist.internalId);
    compactPlaylistPositions(playlist.internalId, remaining.map((row) => row.internalTrackId));
    touchPlaylist.run(playlist.internalId);
  });

  return getMusicPlaylist(normalizedProfile, playlist.playlistId);
}

function reorderMusicPlaylistTracks(profileKey, playlistId, trackIds) {
  const normalizedProfile = normalizeProfileKey(profileKey);
  const playlist = findPlaylist.get(normalizedProfile, String(playlistId || '').trim());
  if (!playlist) return null;
  const normalizedTrackIds = normalizeTrackIds(trackIds, { allowEmpty: true });
  const rows = listPlaylistTrackRows.all(playlist.internalId);
  const currentIds = rows.map((row) => row.trackId);
  if (normalizedTrackIds.length !== currentIds.length
    || normalizedTrackIds.some((trackId) => !currentIds.includes(trackId))) {
    throw new MusicPlaylistError(
      'MUSIC_PLAYLIST_ORDER_MISMATCH',
      'Il nuovo ordine deve contenere esattamente tutti i brani della playlist.',
    );
  }
  const internalByUuid = new Map(rows.map((row) => [row.trackId, row.internalTrackId]));

  transaction(() => {
    compactPlaylistPositions(
      playlist.internalId,
      normalizedTrackIds.map((trackId) => internalByUuid.get(trackId)),
    );
    touchPlaylist.run(playlist.internalId);
  });

  return getMusicPlaylist(normalizedProfile, playlist.playlistId);
}

module.exports = {
  MusicPlaylistError,
  addMusicPlaylistTracks,
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylist,
  listMusicPlaylists,
  normalizePlaylistInput,
  normalizeTrackIds,
  removeMusicPlaylistTrack,
  reorderMusicPlaylistTracks,
  updateMusicPlaylist,
};
