'use strict';

const path = require('node:path');

const MUSIC_FORMAT_DEFINITIONS = Object.freeze({
  mp3: Object.freeze({
    id: 'mp3',
    extension: '.mp3',
    mimeTypes: Object.freeze(['audio/mpeg', 'audio/mp3']),
  }),
  flac: Object.freeze({
    id: 'flac',
    extension: '.flac',
    mimeTypes: Object.freeze(['audio/flac', 'audio/x-flac']),
  }),
  wav: Object.freeze({
    id: 'wav',
    extension: '.wav',
    mimeTypes: Object.freeze(['audio/wav', 'audio/wave', 'audio/x-wav']),
  }),
});

const ALL_MUSIC_EXTENSIONS = new Set(
  Object.values(MUSIC_FORMAT_DEFINITIONS).map((definition) => definition.extension),
);

function normalizeMusicExtension(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('.')) return text;
  return path.extname(text) || `.${text}`;
}

function getMusicFormat(value) {
  const extension = normalizeMusicExtension(value);
  return Object.values(MUSIC_FORMAT_DEFINITIONS)
    .find((definition) => definition.extension === extension) || null;
}

function isMusicExtensionAllowed(value) {
  return Boolean(getMusicFormat(value));
}

function supportedMusicExtensions() {
  return Object.values(MUSIC_FORMAT_DEFINITIONS).map((definition) => definition.extension);
}

module.exports = {
  MUSIC_FORMAT_DEFINITIONS,
  ALL_MUSIC_EXTENSIONS,
  normalizeMusicExtension,
  getMusicFormat,
  isMusicExtensionAllowed,
  supportedMusicExtensions,
};
