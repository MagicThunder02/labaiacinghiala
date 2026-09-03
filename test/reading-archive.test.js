const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  cbzPages,
  estimatePdfPageCount,
  normalizeArchiveName,
  parseZipArchive,
  readZipEntry,
} = require('../src/services/reading-archive-service');

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const input of entries) {
    const name = Buffer.from(input.name, 'utf8');
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data || '');
    const method = input.method === 0 ? 0 : 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function withTempFile(name, data, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baia-reading-'));
  try {
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, data);
    return await callback(filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('CBZ espone pagine logiche in ordine naturale e legge una entry senza estrarla su disco', async () => {
  const zip = makeZip([
    { name: 'pages/', data: Buffer.alloc(0), method: 0 },
    { name: 'pages/10.jpg', data: 'ten' },
    { name: 'pages/2.jpg', data: 'two' },
    { name: 'pages/1.jpg', data: 'one', method: 0 },
    { name: 'notes.txt', data: 'ignored' },
  ]);

  await withTempFile('comic.cbz', zip, async (filePath) => {
    const archive = await parseZipArchive(filePath);
    assert.equal(archive.entries.some((entry) => entry.name === 'pages'), false);
    const pages = cbzPages(archive.entries);
    assert.deepEqual(pages.map((page) => page.name), ['pages/1.jpg', 'pages/2.jpg', 'pages/10.jpg']);
    const selected = archive.entries.find((entry) => entry.id === pages[1].entryId);
    assert.equal((await readZipEntry(filePath, selected)).toString(), 'two');
  });
});

test('nomi archivio con traversal vengono rifiutati', () => {
  assert.throws(() => normalizeArchiveName('../secret.txt'), /percorso non valido/i);
  assert.throws(() => normalizeArchiveName('safe/../../secret.txt'), /percorso non valido/i);
});

test('reader PDF ricava il numero pagine quando il catalogo Pages lo dichiara', async () => {
  const fakePdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Kids [] /Count 123 >> endobj\n%%EOF', 'latin1');
  await withTempFile('book.pdf', fakePdf, async (filePath) => {
    assert.equal(await estimatePdfPageCount(filePath, fakePdf.length), 123);
  });
});
