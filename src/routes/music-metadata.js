'use strict';

const express = require('express');
const {
  MusicMetadataEditError,
  getMusicTrackEmbeddedMetadata,
  updateMusicTrackEmbeddedMetadata,
} = require('../services/music-metadata-edit-service');
const {
  MusicAlbumMetadataEditError,
  getMusicAlbumEmbeddedMetadata,
  updateMusicAlbumEmbeddedMetadata,
} = require('../services/music-album-metadata-edit-service');

const { ContentDeleteError, deleteMusicAlbum } = require('../services/content-delete-service');

const router = express.Router();

function sendMusicMetadataError(res, error) {
  if (error instanceof MusicMetadataEditError || error instanceof MusicAlbumMetadataEditError || error.statusCode) {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      code: error.code || 'MUSIC_METADATA_ERROR',
      contentPreserved: error.contentPreserved !== false,
    });
  }
  throw error;
}


router.get('/albums/:albumId', async (req, res, next) => {
  try {
    const item = await getMusicAlbumEmbeddedMetadata(req.params.albumId);
    return res.json({ item });
  } catch (error) {
    try {
      return sendMusicMetadataError(res, error);
    } catch (unexpected) {
      return next(unexpected);
    }
  }
});


router.delete('/albums/:albumId', async (req, res, next) => {
  try {
    const deleted = await deleteMusicAlbum(req.params.albumId);
    return res.json({ deleted });
  } catch (error) {
    if (error instanceof ContentDeleteError) {
      return res.status(error.statusCode || 409).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
});

router.put('/albums/:albumId', async (req, res, next) => {
  try {
    const item = await updateMusicAlbumEmbeddedMetadata(req.params.albumId, req.body);
    return res.json({ item });
  } catch (error) {
    try {
      return sendMusicMetadataError(res, error);
    } catch (unexpected) {
      return next(unexpected);
    }
  }
});

router.get('/tracks/:trackId', async (req, res, next) => {
  try {
    const item = await getMusicTrackEmbeddedMetadata(req.params.trackId);
    return res.json({ item });
  } catch (error) {
    try {
      return sendMusicMetadataError(res, error);
    } catch (unexpected) {
      return next(unexpected);
    }
  }
});

router.put('/tracks/:trackId', async (req, res, next) => {
  try {
    const item = await updateMusicTrackEmbeddedMetadata(req.params.trackId, req.body);
    return res.json({ item });
  } catch (error) {
    try {
      return sendMusicMetadataError(res, error);
    } catch (unexpected) {
      return next(unexpected);
    }
  }
});

module.exports = router;
