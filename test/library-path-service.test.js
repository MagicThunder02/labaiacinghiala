'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeLibraryRelativePath,
  resolveLibraryPath,
  resolveLibraryPathForWrite,
  toLibraryRelativePath,
  assertInsideLibrary,
} = require('../src/services/library-path-service');

function temporaryLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baia-library-path-'));
  const library = path.join(root, 'media');
  fs.mkdirSync(library, { recursive: true });
  return { root, library };
}

test('normalizza i percorsi persistenti con separatori portabili', () => {
  assert.equal(
    normalizeLibraryRelativePath('Musica\\Black Sabbath\\Paranoid\\01 War Pigs.flac'),
    'Musica/Black Sabbath/Paranoid/01 War Pigs.flac',
  );
  assert.equal(normalizeLibraryRelativePath('./Film//Ratatouille/poster.jpg'), 'Film/Ratatouille/poster.jpg');
});

test('rifiuta percorsi assoluti Windows, UNC e attraversamenti', () => {
  for (const invalid of [
    'C:\\Users\\Utente\\Desktop\\baia\\media\\Film\\film.mkv',
    '\\\\server\\share\\Film\\film.mkv',
    '/srv/baia/media/Film/film.mkv',
    '../altra-cartella/file.mkv',
    'Film/../../Windows/system.ini',
  ]) {
    assert.throws(() => normalizeLibraryRelativePath(invalid), /percorso/i, invalid);
  }
});

test('risolve e riconverte un percorso usando soltanto la radice corrente', () => {
  const { root, library } = temporaryLibrary();
  try {
    const relative = 'Film/Ratatouille (2007)/Ratatouille.mp4';
    const absolute = resolveLibraryPath(relative, { libraryRoot: library });
    assert.equal(absolute, path.join(library, 'Film', 'Ratatouille (2007)', 'Ratatouille.mp4'));
    assert.equal(toLibraryRelativePath(absolute, { libraryRoot: library }), relative);
    assert.equal(assertInsideLibrary(absolute, { libraryRoot: library }), absolute);
    assert.throws(
      () => assertInsideLibrary(path.join(root, 'outside.mp4'), { libraryRoot: library }),
      /estern[oa] alla libreria/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rifiuta una scrittura che attraversa un collegamento simbolico esterno', async (t) => {
  const { root, library } = temporaryLibrary();
  const outside = path.join(root, 'outside');
  const link = path.join(library, 'Film');
  fs.mkdirSync(outside, { recursive: true });
  try {
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`collegamenti simbolici non disponibili: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      resolveLibraryPathForWrite('Film/Nuovo/poster.jpg', { libraryRoot: library }),
      /collegamento esterno/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
