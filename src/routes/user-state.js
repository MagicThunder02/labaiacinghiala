const express = require('express');
const db = require('../database');
const { getProfileKey } = require('../utils/profile-key');

const router = express.Router();

const movieExists = db.prepare('SELECT 1 FROM movies WHERE id = ?');
const getProgress = db.prepare(`
  SELECT seconds, duration_seconds AS durationSeconds, completed, updated_at AS updatedAt
  FROM watch_progress
  WHERE movie_id = ? AND profile_key = ?
`);
const saveProgress = db.prepare(`
  INSERT INTO watch_progress (
    movie_id, profile_key, seconds, duration_seconds, completed, updated_at
  ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(movie_id, profile_key) DO UPDATE SET
    seconds = excluded.seconds,
    duration_seconds = excluded.duration_seconds,
    completed = excluded.completed,
    updated_at = CURRENT_TIMESTAMP
`);
const isFavorite = db.prepare(`
  SELECT 1 FROM favorites WHERE movie_id = ? AND profile_key = ?
`);
const addFavorite = db.prepare(`
  INSERT OR IGNORE INTO favorites (movie_id, profile_key) VALUES (?, ?)
`);
const removeFavorite = db.prepare(`
  DELETE FROM favorites WHERE movie_id = ? AND profile_key = ?
`);

function validateMovie(req, res) {
  if (!movieExists.get(req.params.id)) {
    res.status(404).json({ error: 'Contenuto non trovato.' });
    return false;
  }
  return true;
}

router.get('/:id/progress', (req, res) => {
  if (!validateMovie(req, res)) return;
  const profileKey = getProfileKey(req);
  const progress = getProgress.get(req.params.id, profileKey) || {
    seconds: 0,
    durationSeconds: 0,
    completed: 0,
    updatedAt: null,
  };
  res.json({
    progress: {
      ...progress,
      seconds: Number(progress.seconds),
      durationSeconds: Number(progress.durationSeconds),
      completed: Boolean(progress.completed),
    },
  });
});

router.put('/:id/progress', (req, res) => {
  if (!validateMovie(req, res)) return;

  const profileKey = getProfileKey(req);
  const seconds = Number(req.body.seconds);
  const durationSeconds = Number(req.body.durationSeconds || 0);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return res.status(400).json({ error: 'Valore di avanzamento non valido.' });
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return res.status(400).json({ error: 'Durata non valida.' });
  }

  const normalizedSeconds = durationSeconds > 0
    ? Math.min(seconds, durationSeconds)
    : seconds;
  const completed = durationSeconds > 0 && normalizedSeconds / durationSeconds >= 0.92;

  saveProgress.run(
    req.params.id,
    profileKey,
    normalizedSeconds,
    durationSeconds,
    completed ? 1 : 0
  );

  return res.json({
    progress: {
      seconds: normalizedSeconds,
      durationSeconds,
      completed,
    },
  });
});

router.get('/:id/favorite', (req, res) => {
  if (!validateMovie(req, res)) return;
  const profileKey = getProfileKey(req);
  res.json({ favorite: Boolean(isFavorite.get(req.params.id, profileKey)) });
});

router.put('/:id/favorite', (req, res) => {
  if (!validateMovie(req, res)) return;
  const profileKey = getProfileKey(req);
  const favorite = Boolean(req.body.favorite);
  if (favorite) addFavorite.run(req.params.id, profileKey);
  else removeFavorite.run(req.params.id, profileKey);
  return res.json({ favorite });
});

module.exports = router;
