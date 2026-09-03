const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function sanitizeFileStem(value, fallback = 'contenuto') {
  let stem = String(value ?? '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' - ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
    .trim();

  if (!stem) stem = fallback;
  if (WINDOWS_RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  return stem;
}

module.exports = { sanitizeFileStem };
