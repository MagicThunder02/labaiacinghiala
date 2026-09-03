'use strict';

const MAX_MUSIC_COVER_EDIT_BYTES = 6 * 1024 * 1024;
const MAX_MUSIC_COVER_DIMENSION = 8000;
const MUSIC_COVER_ACTIONS = new Set(['keep', 'replace', 'remove']);

class MusicCoverEditError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MusicCoverEditError';
    this.code = code;
    this.statusCode = options.statusCode || 400;
  }
}

function detectPngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {
    mimeType: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function isJpegStartOfFrame(marker) {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ].includes(marker);
}

function detectJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) break;
      return {
        mimeType: 'image/jpeg',
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function detectMusicCoverImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  return detectPngDimensions(buffer) || detectJpegDimensions(buffer);
}

function validateMusicCoverBuffer(buffer, declaredMimeType = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new MusicCoverEditError('MUSIC_COVER_EMPTY', 'La copertina selezionata è vuota.');
  }
  if (buffer.length > MAX_MUSIC_COVER_EDIT_BYTES) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_TOO_LARGE',
      'La copertina deve avere dimensione massima di 6 MB.',
      { statusCode: 413 },
    );
  }
  const image = detectMusicCoverImage(buffer);
  if (!image) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_FORMAT_UNSUPPORTED',
      'La copertina deve essere un file JPEG o PNG valido.',
    );
  }
  const declared = String(declaredMimeType || '').trim().toLowerCase();
  if (declared && declared !== image.mimeType) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_MIME_MISMATCH',
      'Il formato dichiarato della copertina non corrisponde ai dati reali del file.',
    );
  }
  if (!image.width || !image.height
      || image.width > MAX_MUSIC_COVER_DIMENSION
      || image.height > MAX_MUSIC_COVER_DIMENSION) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_DIMENSIONS_INVALID',
      `La copertina non può superare ${MAX_MUSIC_COVER_DIMENSION} × ${MAX_MUSIC_COVER_DIMENSION} pixel.`,
    );
  }
  return { ...image, sizeBytes: buffer.length };
}

function parseMusicCoverDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_DATA_INVALID',
      'La nuova copertina deve essere un’immagine JPEG o PNG valida.',
    );
  }
  const buffer = Buffer.from(match[2], 'base64');
  const image = validateMusicCoverBuffer(buffer, match[1]);
  return { buffer, ...image };
}

function normalizeMusicCoverChange(input = {}) {
  const action = String(input.coverAction || 'keep').trim().toLowerCase();
  if (!MUSIC_COVER_ACTIONS.has(action)) {
    throw new MusicCoverEditError(
      'MUSIC_COVER_ACTION_INVALID',
      'Azione copertina non valida.',
    );
  }
  if (action === 'keep') return Object.freeze({ action: 'keep' });
  if (action === 'remove') return Object.freeze({ action: 'remove' });
  const artwork = parseMusicCoverDataUrl(input.coverDataUrl);
  return Object.freeze({
    action: 'replace',
    data: artwork.buffer,
    mimeType: artwork.mimeType,
    width: artwork.width,
    height: artwork.height,
    sizeBytes: artwork.sizeBytes,
  });
}

module.exports = {
  MAX_MUSIC_COVER_EDIT_BYTES,
  MAX_MUSIC_COVER_DIMENSION,
  MusicCoverEditError,
  detectMusicCoverImage,
  validateMusicCoverBuffer,
  parseMusicCoverDataUrl,
  normalizeMusicCoverChange,
};
