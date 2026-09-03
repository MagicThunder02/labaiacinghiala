function normalizeProfileKey(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return normalized || 'default';
}

function getProfileKey(req) {
  if (req.baiaAccount?.accountKey) return normalizeProfileKey(req.baiaAccount.accountKey);
  throw new Error('Account Baia non risolto per la richiesta.');
}

module.exports = { getProfileKey, normalizeProfileKey };
