const path = require('node:path');

function parseMediaFilename(fileName) {
  const extension = path.extname(fileName);
  let base = path.basename(fileName, extension);

  const yearMatch = base.match(/(?:^|[\s._\-(\[])((?:19|20)\d{2})(?=$|[\s._\-)\]])/);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;

  base = base
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:19|20)\d{2}[^)]*\)/g, ' ')
    .replace(/(?:^|[\s._-])(?:19|20)\d{2}(?=$|[\s._-])/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s+/g, ' — ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    title: base || path.basename(fileName, extension),
    year,
  };
}

module.exports = { parseMediaFilename };
