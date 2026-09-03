const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const mime = require('mime-types');

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SCAN = 22 + 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

function archiveError(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeArchiveName(value) {
  const name = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!name || name.includes('\0')) throw archiveError('Archivio contiene un nome file non valido.');
  const parts = name.split('/');
  if (parts.some((part) => part === '..')) throw archiveError('Archivio contiene un percorso non valido.');
  return parts.filter((part) => part && part !== '.').join('/');
}

function decodeArchiveName(buffer, utf8) {
  return normalizeArchiveName(buffer.toString(utf8 ? 'utf8' : 'latin1'));
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw archiveError('Archivio troncato o non valido.');
    offset += bytesRead;
  }
  return buffer;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function validateEntrySizes(compressedSize, uncompressedSize) {
  if (uncompressedSize > MAX_ENTRY_BYTES) throw archiveError('Una risorsa interna supera il limite di sicurezza del reader.');
  if (compressedSize > MAX_ENTRY_BYTES) throw archiveError('Una risorsa compressa supera il limite di sicurezza del reader.');
  if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
    throw archiveError('Archivio rifiutato: rapporto di compressione anomalo.');
  }
}

async function parseZipArchive(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 22) throw archiveError('Archivio non valido.');
    const tailLength = Math.min(stats.size, MAX_EOCD_SCAN);
    const tail = await readExact(handle, tailLength, stats.size - tailLength);
    const eocdOffset = findEndOfCentralDirectory(tail);
    if (eocdOffset < 0) throw archiveError('Fine archivio ZIP non trovata.');

    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDisk = tail.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);

    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw archiveError('Archivi ZIP multi-volume non supportati.');
    }
    if (totalEntries === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) {
      throw archiveError('Archivi ZIP64 non supportati dal reader attuale.');
    }
    if (totalEntries > MAX_ARCHIVE_ENTRIES) throw archiveError('Archivio con troppi elementi.');
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > stats.size) {
      throw archiveError('Directory centrale ZIP non valida.');
    }

    const central = await readExact(handle, centralSize, centralOffset);
    const entries = [];
    let offset = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw archiveError('Directory centrale ZIP danneggiata.');
      }
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localHeaderOffset = central.readUInt32LE(offset + 42);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > central.length) throw archiveError('Directory centrale ZIP troncata.');
      if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
        throw archiveError('Archivi ZIP64 non supportati dal reader attuale.');
      }
      if (flags & 0x1) throw archiveError('Archivi protetti da password non supportati.');
      if (![0, 8].includes(method)) throw archiveError('Metodo di compressione ZIP non supportato.');
      validateEntrySizes(compressedSize, uncompressedSize);

      const rawName = central.subarray(offset + 46, offset + 46 + nameLength);
      const decodedName = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1');
      const isDirectory = decodedName.replaceAll('\\', '/').endsWith('/');
      const name = decodeArchiveName(rawName, Boolean(flags & 0x800));
      if (!isDirectory) {
        entries.push({
          id: entries.length,
          name,
          method,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
          mimeType: mime.lookup(name) || 'application/octet-stream',
        });
      }
      offset += recordLength;
    }
    return { filePath, sizeBytes: stats.size, entries };
  } finally {
    await handle.close();
  }
}

async function readZipEntry(filePath, entry) {
  if (!entry || !Number.isInteger(entry.localHeaderOffset)) throw archiveError('Risorsa archivio non valida.', 404);
  const handle = await fs.open(filePath, 'r');
  try {
    const local = await readExact(handle, 30, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw archiveError('Header locale ZIP non valido.');
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = await readExact(handle, entry.compressedSize, dataOffset);
    let output;
    if (entry.method === 0) output = compressed;
    else if (entry.method === 8) output = await inflateRaw(compressed);
    else throw archiveError('Metodo di compressione ZIP non supportato.');
    if (output.length !== entry.uncompressedSize) throw archiveError('Risorsa ZIP danneggiata o incompleta.');
    return output;
  } finally {
    await handle.close();
  }
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'it', { numeric: true, sensitivity: 'base' });
}

function cbzPages(entries) {
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
  return entries
    .filter((entry) => allowed.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => naturalCompare(left.name, right.name))
    .map((entry, pageIndex) => ({
      entryId: entry.id,
      page: pageIndex + 1,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.uncompressedSize,
    }));
}

function epubEntries(entries) {
  return entries.map((entry) => ({
    entryId: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    sizeBytes: entry.uncompressedSize,
  }));
}

async function estimatePdfPageCount(filePath, sizeBytes = 0) {
  const stats = sizeBytes > 0 ? { size: sizeBytes } : await fs.stat(filePath);
  if (stats.size <= 0) return null;
  const handle = await fs.open(filePath, 'r');
  const chunkSize = 512 * 1024;
  const maximumBytes = Math.min(stats.size, 64 * 1024 * 1024);
  let position = 0;
  let overlap = '';
  let maximumCount = 0;
  try {
    while (position < maximumBytes) {
      const length = Math.min(chunkSize, maximumBytes - position);
      const buffer = await readExact(handle, length, position);
      const text = overlap + buffer.toString('latin1');
      const patterns = [
        /\/Type\s*\/Pages\b[\s\S]{0,768}?\/Count\s+(\d+)/g,
        /\/Count\s+(\d+)[\s\S]{0,768}?\/Type\s*\/Pages\b/g,
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const count = Number(match[1]);
          if (Number.isInteger(count) && count > maximumCount && count <= 10_000_000) maximumCount = count;
        }
      }
      overlap = text.slice(-2048);
      position += length;
    }
  } finally {
    await handle.close();
  }
  return maximumCount || null;
}

module.exports = {
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  cbzPages,
  epubEntries,
  estimatePdfPageCount,
  normalizeArchiveName,
  parseZipArchive,
  readZipEntry,
};
