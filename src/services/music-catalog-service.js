'use strict';

const db = require('../database');
const { buildMusicHome } = require('./music-home-service');

const HOME_RECENT_LIMIT = 10;
const HOME_LATEST_LIMIT = 20;
const HOME_RECOMMENDED_LIMIT = 30;

const listAlbumRows = db.prepare(`
  SELECT
    a.id AS internalId,
    a.album_uuid AS albumId,
    a.title,
    a.album_artists_json AS albumArtistsJson,
    a.genres_json AS genresJson,
    a.year,
    a.compilation,
    a.cover_cache_path AS coverCachePath,
    a.added_at AS addedAt,
    a.updated_at AS updatedAt,
    COUNT(t.id) AS trackCount,
    COALESCE(SUM(t.duration_seconds), 0) AS durationSeconds,
    COALESCE(MAX(t.has_cover_art), 0) AS hasEmbeddedCover,
    COUNT(DISTINCT CASE WHEN f.track_id IS NOT NULL THEN t.id END) AS favoriteTrackCount,
    MAX(h.last_played_at) AS lastPlayedAt
  FROM music_albums a
  JOIN music_tracks t ON t.album_id = a.id AND t.available = 1
  LEFT JOIN music_track_favorites f ON f.track_id = t.id AND f.profile_key = ?
  LEFT JOIN music_listening_history h ON h.track_id = t.id AND h.profile_key = ?
  GROUP BY a.id
  ORDER BY a.title COLLATE NOCASE ASC
`);

const listTrackRows = db.prepare(`
  SELECT
    t.id AS internalId,
    t.track_uuid AS trackId,
    t.album_id AS internalAlbumId,
    t.title,
    t.artists_json AS artistsJson,
    t.genres_json AS genresJson,
    t.composers_json AS composersJson,
    t.comment,
    t.date_text AS date,
    t.year,
    t.track_number AS trackNumber,
    t.track_total AS trackTotal,
    t.disc_number AS discNumber,
    t.disc_total AS discTotal,
    t.compilation,
    t.extension,
    t.mime_type AS mimeType,
    t.duration_seconds AS durationSeconds,
    t.duration_ms AS durationMs,
    t.bitrate_kbps AS bitrateKbps,
    t.sample_rate_hz AS sampleRateHz,
    t.channels,
    t.bits_per_sample AS bitsPerSample,
    t.codec,
    t.container_format AS containerFormat,
    t.is_lossless AS isLossless,
    t.bitrate_mode AS bitrateMode,
    t.size_bytes AS sizeBytes,
    t.has_cover_art AS hasCoverArt,
    t.added_at AS addedAt,
    t.updated_at AS updatedAt,
    a.album_uuid AS albumId,
    a.title AS albumTitle,
    a.album_artists_json AS albumArtistsJson,
    a.year AS albumYear,
    a.compilation AS albumCompilation,
    a.cover_cache_path AS albumCoverCachePath,
    CASE WHEN f.track_id IS NULL THEN 0 ELSE 1 END AS favorite,
    COALESCE(h.play_count, 0) AS playCount,
    COALESCE(h.completed_count, 0) AS completedCount,
    COALESCE(h.last_position_seconds, 0) AS lastPositionSeconds,
    COALESCE(h.last_duration_seconds, 0) AS lastDurationSeconds,
    h.last_played_at AS lastPlayedAt
  FROM music_tracks t
  JOIN music_albums a ON a.id = t.album_id
  LEFT JOIN music_track_favorites f ON f.track_id = t.id AND f.profile_key = ?
  LEFT JOIN music_listening_history h ON h.track_id = t.id AND h.profile_key = ?
  WHERE t.available = 1
  ORDER BY
    a.title COLLATE NOCASE ASC,
    COALESCE(t.disc_number, 1) ASC,
    COALESCE(t.track_number, 999999) ASC,
    t.title COLLATE NOCASE ASC
`);

const listArtistRows = db.prepare(`
  SELECT id AS internalId, artist_uuid AS artistId, name, sort_name AS sortName,
         added_at AS addedAt, updated_at AS updatedAt
  FROM music_artists
  ORDER BY COALESCE(NULLIF(sort_name, ''), name) COLLATE NOCASE ASC
`);

const listAlbumArtistRelations = db.prepare(`
  SELECT aa.album_id AS internalAlbumId, aa.artist_id AS internalArtistId,
         ar.artist_uuid AS artistId, ar.name, aa.position
  FROM music_album_artists aa
  JOIN music_artists ar ON ar.id = aa.artist_id
  ORDER BY aa.album_id, aa.position
`);

const listTrackArtistRelations = db.prepare(`
  SELECT ta.track_id AS internalTrackId, ta.artist_id AS internalArtistId,
         ar.artist_uuid AS artistId, ar.name, ta.position
  FROM music_track_artists ta
  JOIN music_artists ar ON ar.id = ta.artist_id
  ORDER BY ta.track_id, ta.position
`);

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toBoolean(value) {
  return value === 1 || value === true;
}

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('it');
}

function normalizedSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('it')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function searchMatchScore(value, query) {
  const text = normalizedSearchText(value);
  if (!text || !query) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 760;

  const words = text.split(' ');
  if (words.includes(query)) return 700;
  if (words.some((word) => word.startsWith(query))) return 640;
  if (text.includes(query)) return 500;

  const queryTokens = query.split(' ').filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.every((token) => text.includes(token))) return 420;
  return 0;
}

function bestSearchScore(values, query, bonus = 0) {
  const score = Math.max(0, ...values.map((value) => searchMatchScore(value, query)));
  return score > 0 ? score + bonus : 0;
}

function sortSearchMatches(left, right) {
  return right._score - left._score
    || String(left.title || left.name || '').localeCompare(
      String(right.title || right.name || ''),
      'it',
      { sensitivity: 'base' },
    );
}

function withoutSearchScore(item) {
  const { _score, ...clean } = item;
  return clean;
}

function relationMap(rows, idKey) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row[idKey]);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({ artistId: row.artistId, name: row.name });
  }
  return map;
}

function fallbackArtists(jsonValue) {
  return parseJsonList(jsonValue).map((name) => ({ artistId: null, name }));
}

function serializeAlbum(row, albumArtistsById) {
  const trackCount = Number(row.trackCount || 0);
  const favoriteTrackCount = Number(row.favoriteTrackCount || 0);
  const artists = albumArtistsById.get(Number(row.internalId)) || fallbackArtists(row.albumArtistsJson);
  const hasCoverArt = Boolean(row.coverCachePath) || toBoolean(row.hasEmbeddedCover);
  return {
    albumId: row.albumId,
    title: row.title,
    artists,
    genres: parseJsonList(row.genresJson),
    year: row.year == null ? null : Number(row.year),
    compilation: toBoolean(row.compilation),
    trackCount,
    durationSeconds: Number(row.durationSeconds || 0),
    favoriteTrackCount,
    favorite: favoriteTrackCount > 0,
    fullyFavorite: trackCount > 0 && favoriteTrackCount === trackCount,
    hasCoverArt,
    coverUrl: hasCoverArt
      ? `/api/music/albums/${encodeURIComponent(row.albumId)}/cover?v=${encodeURIComponent(row.updatedAt || '')}`
      : null,
    lastPlayedAt: row.lastPlayedAt || null,
    addedAt: row.addedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function serializeTrack(row, trackArtistsById, albumByInternalId) {
  const album = albumByInternalId.get(Number(row.internalAlbumId));
  const artists = trackArtistsById.get(Number(row.internalId)) || fallbackArtists(row.artistsJson);
  return {
    trackId: row.trackId,
    title: row.title,
    artists,
    albumId: row.albumId,
    albumTitle: row.albumTitle,
    albumArtists: album?.artists || fallbackArtists(row.albumArtistsJson),
    albumYear: row.albumYear == null ? null : Number(row.albumYear),
    genres: parseJsonList(row.genresJson),
    composers: parseJsonList(row.composersJson),
    comment: row.comment || '',
    date: row.date || '',
    year: row.year == null ? null : Number(row.year),
    trackNumber: row.trackNumber == null ? null : Number(row.trackNumber),
    trackTotal: row.trackTotal == null ? null : Number(row.trackTotal),
    discNumber: row.discNumber == null ? null : Number(row.discNumber),
    discTotal: row.discTotal == null ? null : Number(row.discTotal),
    compilation: toBoolean(row.compilation),
    extension: row.extension,
    mimeType: row.mimeType,
    durationSeconds: Number(row.durationSeconds || 0),
    durationMs: Number(row.durationMs || 0),
    bitrateKbps: row.bitrateKbps == null ? null : Number(row.bitrateKbps),
    sampleRateHz: row.sampleRateHz == null ? null : Number(row.sampleRateHz),
    channels: row.channels == null ? null : Number(row.channels),
    bitsPerSample: row.bitsPerSample == null ? null : Number(row.bitsPerSample),
    codec: row.codec || null,
    containerFormat: row.containerFormat || null,
    lossless: toBoolean(row.isLossless),
    bitrateMode: row.bitrateMode || null,
    sizeBytes: Number(row.sizeBytes || 0),
    hasCoverArt: Boolean(album?.hasCoverArt) || toBoolean(row.hasCoverArt) || Boolean(row.albumCoverCachePath),
    coverUrl: album?.coverUrl || null,
    streamUrl: `/api/music/tracks/${encodeURIComponent(row.trackId)}/stream`,
    favorite: toBoolean(row.favorite),
    playCount: Number(row.playCount || 0),
    completedCount: Number(row.completedCount || 0),
    lastPositionSeconds: Number(row.lastPositionSeconds || 0),
    lastDurationSeconds: Number(row.lastDurationSeconds || 0),
    lastPlayedAt: row.lastPlayedAt || null,
    addedAt: row.addedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function loadCatalog(profileKey) {
  const albumArtistsById = relationMap(listAlbumArtistRelations.all(), 'internalAlbumId');
  const trackArtistsById = relationMap(listTrackArtistRelations.all(), 'internalTrackId');
  const albumRows = listAlbumRows.all(profileKey, profileKey);
  const albumByInternalId = new Map(
    albumRows.map((row) => [Number(row.internalId), serializeAlbum(row, albumArtistsById)]),
  );
  const albums = [...albumByInternalId.values()];
  const tracks = listTrackRows.all(profileKey, profileKey)
    .map((row) => serializeTrack(row, trackArtistsById, albumByInternalId));
  return { albums, tracks };
}

function parsePositiveInteger(value, fallback, maximum = 250) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function paginate(items, query = {}) {
  const offset = parseOffset(query.offset);
  const limit = parsePositiveInteger(query.limit, 100);
  return {
    items: items.slice(offset, offset + limit),
    count: items.length,
    offset,
    limit,
  };
}

function textMatches(values, search) {
  if (!search) return true;
  return values.some((value) => normalizedText(value).includes(search));
}

function matchesGenre(genres, genre) {
  if (!genre) return true;
  return (genres || []).some((value) => normalizedText(value) === genre);
}

function sortAlbums(albums, sort) {
  const result = [...albums];
  if (sort === 'added') {
    result.sort((left, right) => Date.parse(right.addedAt || '') - Date.parse(left.addedAt || ''));
  } else if (sort === 'year') {
    result.sort((left, right) => (right.year || 0) - (left.year || 0)
      || left.title.localeCompare(right.title, 'it', { sensitivity: 'base' }));
  } else if (sort === 'recent') {
    result.sort((left, right) => Date.parse(right.lastPlayedAt || '') - Date.parse(left.lastPlayedAt || '')
      || left.title.localeCompare(right.title, 'it', { sensitivity: 'base' }));
  } else {
    result.sort((left, right) => left.title.localeCompare(right.title, 'it', { sensitivity: 'base' }));
  }
  return result;
}

function listMusicAlbums(profileKey, query = {}) {
  const { albums } = loadCatalog(profileKey);
  const search = normalizedText(query.search).slice(0, 200);
  const genre = normalizedText(query.genre);
  const year = Number.parseInt(query.year, 10);
  const artistId = String(query.artistId || '').trim();
  const favoritesOnly = ['1', 'true', 'yes'].includes(normalizedText(query.favoritesOnly));

  const filtered = albums.filter((album) => (
    textMatches([album.title, ...album.artists.map((artist) => artist.name)], search)
    && matchesGenre(album.genres, genre)
    && (!Number.isInteger(year) || year <= 0 || album.year === year)
    && (!artistId || album.artists.some((artist) => artist.artistId === artistId))
    && (!favoritesOnly || album.favoriteTrackCount > 0)
  ));
  const page = paginate(sortAlbums(filtered, String(query.sort || 'title').toLowerCase()), query);
  return { albums: page.items, count: page.count, offset: page.offset, limit: page.limit };
}

function listMusicTracks(profileKey, query = {}) {
  const { tracks } = loadCatalog(profileKey);
  const search = normalizedText(query.search).slice(0, 200);
  const genre = normalizedText(query.genre);
  const albumId = String(query.albumId || '').trim();
  const artistId = String(query.artistId || '').trim();
  const favoritesOnly = ['1', 'true', 'yes'].includes(normalizedText(query.favoritesOnly));

  let filtered = tracks.filter((track) => (
    textMatches([
      track.title,
      track.albumTitle,
      ...track.artists.map((artist) => artist.name),
      ...track.albumArtists.map((artist) => artist.name),
    ], search)
    && matchesGenre(track.genres, genre)
    && (!albumId || track.albumId === albumId)
    && (!artistId || track.artists.some((artist) => artist.artistId === artistId))
    && (!favoritesOnly || track.favorite)
  ));

  const sort = String(query.sort || 'album').toLowerCase();
  if (sort === 'recent') {
    filtered = [...filtered].sort((left, right) => Date.parse(right.lastPlayedAt || '') - Date.parse(left.lastPlayedAt || ''));
  } else if (sort === 'title') {
    filtered = [...filtered].sort((left, right) => left.title.localeCompare(right.title, 'it', { sensitivity: 'base' }));
  }

  const page = paginate(filtered, query);
  return { tracks: page.items, count: page.count, offset: page.offset, limit: page.limit };
}

function compareAlbumTitles(left, right) {
  return String(left.title || '').localeCompare(
    String(right.title || ''),
    'it',
    { sensitivity: 'base' },
  );
}

function buildArtists(albums, tracks) {
  const rowsById = new Map(listArtistRows.all().map((row) => [row.artistId, row]));
  const albumsByArtist = new Map();

  for (const album of albums) {
    for (const artist of album.artists || []) {
      if (!artist?.artistId || !rowsById.has(artist.artistId)) continue;
      if (!albumsByArtist.has(artist.artistId)) albumsByArtist.set(artist.artistId, []);
      albumsByArtist.get(artist.artistId).push(album);
    }
  }

  return [...albumsByArtist.entries()].map(([artistId, artistAlbums]) => {
    const row = rowsById.get(artistId);
    const orderedAlbums = [...artistAlbums].sort(compareAlbumTitles);
    const albumIds = new Set(orderedAlbums.map((album) => album.albumId));
    const artistTracks = tracks.filter((track) => albumIds.has(track.albumId));
    let lastPlayedAt = null;

    for (const track of artistTracks) {
      if (!lastPlayedAt || Date.parse(track.lastPlayedAt || '') > Date.parse(lastPlayedAt || '')) {
        lastPlayedAt = track.lastPlayedAt || lastPlayedAt;
      }
    }

    return {
      artistId: row.artistId,
      name: row.name,
      sortName: row.sortName || null,
      albumCount: orderedAlbums.length,
      trackCount: artistTracks.length,
      durationSeconds: artistTracks.reduce((total, track) => total + track.durationSeconds, 0),
      lastPlayedAt,
      coverUrls: orderedAlbums
        .map((album) => album.coverUrl)
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 4),
      addedAt: row.addedAt || null,
      updatedAt: row.updatedAt || null,
    };
  }).sort((left, right) => (left.sortName || left.name).localeCompare(
    right.sortName || right.name,
    'it',
    { sensitivity: 'base' },
  ));
}

function loadArtists(profileKey) {
  const { albums, tracks } = loadCatalog(profileKey);
  return buildArtists(albums, tracks);
}

function listMusicArtists(profileKey, query = {}) {
  const search = normalizedText(query.search).slice(0, 200);
  const artists = loadArtists(profileKey)
    .filter((artist) => !search || normalizedText(artist.name).includes(search))
    .sort((left, right) => (left.sortName || left.name).localeCompare(
      right.sortName || right.name,
      'it',
      { sensitivity: 'base' },
    ));
  const page = paginate(artists, query);
  return { artists: page.items, count: page.count, offset: page.offset, limit: page.limit };
}

function getMusicAlbum(profileKey, albumId, query = {}) {
  const { albums, tracks } = loadCatalog(profileKey);
  const album = albums.find((item) => item.albumId === albumId);
  if (!album) return null;
  const favoritesOnly = ['1', 'true', 'yes'].includes(normalizedText(query.favoritesOnly));
  return {
    album,
    tracks: tracks.filter((track) => track.albumId === albumId && (!favoritesOnly || track.favorite)),
  };
}

function getMusicTrack(profileKey, trackId) {
  const { tracks } = loadCatalog(profileKey);
  return tracks.find((track) => track.trackId === trackId) || null;
}

function getMusicTracksByIds(profileKey, trackIds = []) {
  const ids = Array.isArray(trackIds)
    ? trackIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!ids.length) return [];
  const { tracks } = loadCatalog(profileKey);
  const byId = new Map(tracks.map((track) => [track.trackId, track]));
  return ids.map((trackId) => byId.get(trackId)).filter(Boolean);
}

function getMusicArtist(profileKey, artistId) {
  const { albums, tracks } = loadCatalog(profileKey);
  const artist = buildArtists(albums, tracks).find((item) => item.artistId === artistId);
  if (!artist) return null;
  const artistAlbums = albums
    .filter((album) => album.artists.some((item) => item.artistId === artistId))
    .sort(compareAlbumTitles);
  const albumIds = new Set(artistAlbums.map((album) => album.albumId));
  return {
    artist,
    albums: artistAlbums,
    tracks: tracks.filter((track) => albumIds.has(track.albumId)),
  };
}

function getMusicFilters(profileKey) {
  const { albums, tracks } = loadCatalog(profileKey);
  const genres = new Set();
  const years = new Set();
  for (const item of [...albums, ...tracks]) {
    for (const genre of item.genres || []) genres.add(genre);
    if (Number.isInteger(item.year) && item.year > 0) years.add(item.year);
  }
  return {
    genres: [...genres].sort((left, right) => left.localeCompare(right, 'it', { sensitivity: 'base' })),
    years: [...years].sort((left, right) => right - left),
  };
}

function getMusicHome(profileKey) {
  const { albums, tracks } = loadCatalog(profileKey);
  const artists = buildArtists(albums, tracks);
  return {
    ...buildMusicHome(albums, tracks, profileKey, {
      recentLimit: HOME_RECENT_LIMIT,
      latestLimit: HOME_LATEST_LIMIT,
      recommendedLimit: HOME_RECOMMENDED_LIMIT,
    }),
    summary: {
      albumCount: albums.length,
      artistCount: artists.length,
      trackCount: tracks.length,
    },
  };
}

function buildGenreSearchItems(albums, tracks) {
  const albumById = new Map(albums.map((album) => [album.albumId, album]));
  const byKey = new Map();

  function ensureGenre(name) {
    const displayName = String(name || '').trim();
    const key = normalizedSearchText(displayName);
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: displayName,
        albumIds: new Set(),
        trackIds: new Set(),
      });
    }
    return byKey.get(key);
  }

  for (const album of albums) {
    for (const genre of album.genres || []) ensureGenre(genre)?.albumIds.add(album.albumId);
  }
  for (const track of tracks) {
    for (const genre of track.genres || []) {
      const item = ensureGenre(genre);
      if (!item) continue;
      item.albumIds.add(track.albumId);
      item.trackIds.add(track.trackId);
    }
  }

  return [...byKey.values()].map((item) => ({
    name: item.name,
    albumCount: item.albumIds.size,
    trackCount: item.trackIds.size,
    coverUrls: [...item.albumIds]
      .map((albumId) => albumById.get(albumId)?.coverUrl)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 4),
  }));
}

function searchMusicCatalog(profileKey, query = {}) {
  const rawQuery = String(query.q ?? query.search ?? '').trim().slice(0, 200);
  const normalizedQuery = normalizedSearchText(rawQuery);
  const minimumLength = 2;
  const empty = {
    query: rawQuery,
    minimumLength,
    topResult: null,
    tracks: [],
    albums: [],
    artists: [],
    genres: [],
    counts: { tracks: 0, albums: 0, artists: 0, genres: 0, total: 0 },
  };
  if (normalizedQuery.length < minimumLength) return empty;

  const { albums, tracks } = loadCatalog(profileKey);
  const artists = buildArtists(albums, tracks);
  const genres = buildGenreSearchItems(albums, tracks);

  const albumMatches = albums.map((album) => ({
    ...album,
    _score: Math.max(
      bestSearchScore([album.title], normalizedQuery, 45),
      bestSearchScore((album.artists || []).map((artist) => artist.name), normalizedQuery, 24),
      bestSearchScore(album.genres || [], normalizedQuery, 8),
    ),
  })).filter((album) => album._score > 0).sort(sortSearchMatches);

  const artistMatches = artists.map((artist) => ({
    ...artist,
    _score: bestSearchScore([artist.name, artist.sortName], normalizedQuery, 55),
  })).filter((artist) => artist._score > 0).sort(sortSearchMatches);

  const trackMatches = tracks.map((track) => ({
    ...track,
    _score: Math.max(
      bestSearchScore([track.title], normalizedQuery, 40),
      bestSearchScore((track.artists || []).map((artist) => artist.name), normalizedQuery, 28),
      bestSearchScore([track.albumTitle], normalizedQuery, 18),
      bestSearchScore(track.genres || [], normalizedQuery, 6),
    ),
  })).filter((track) => track._score > 0).sort(sortSearchMatches);

  const genreMatches = genres.map((genre) => ({
    ...genre,
    _score: bestSearchScore([genre.name], normalizedQuery, 12),
  })).filter((genre) => genre._score > 0).sort(sortSearchMatches);

  const limit = parsePositiveInteger(query.limit, 8, 20);
  const trackLimit = parsePositiveInteger(query.trackLimit, 10, 30);
  const topCandidates = [
    ...artistMatches.map((item) => ({ type: 'artist', item, score: item._score })),
    ...albumMatches.map((item) => ({ type: 'album', item, score: item._score })),
    ...trackMatches.map((item) => ({ type: 'track', item, score: item._score })),
    ...genreMatches.map((item) => ({ type: 'genre', item, score: item._score })),
  ].sort((left, right) => right.score - left.score
    || ['artist', 'album', 'track', 'genre'].indexOf(left.type)
      - ['artist', 'album', 'track', 'genre'].indexOf(right.type));

  const counts = {
    tracks: trackMatches.length,
    albums: albumMatches.length,
    artists: artistMatches.length,
    genres: genreMatches.length,
  };
  counts.total = counts.tracks + counts.albums + counts.artists + counts.genres;

  return {
    query: rawQuery,
    minimumLength,
    topResult: topCandidates[0]
      ? { type: topCandidates[0].type, item: withoutSearchScore(topCandidates[0].item) }
      : null,
    tracks: trackMatches.slice(0, trackLimit).map(withoutSearchScore),
    albums: albumMatches.slice(0, limit).map(withoutSearchScore),
    artists: artistMatches.slice(0, limit).map(withoutSearchScore),
    genres: genreMatches.slice(0, limit).map(withoutSearchScore),
    counts,
  };
}

module.exports = {
  getMusicAlbum,
  getMusicArtist,
  getMusicFilters,
  getMusicHome,
  getMusicTrack,
  getMusicTracksByIds,
  listMusicAlbums,
  listMusicArtists,
  listMusicTracks,
  searchMusicCatalog,
};
