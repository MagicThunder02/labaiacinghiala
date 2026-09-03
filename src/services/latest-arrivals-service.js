'use strict';

const DEFAULT_LATEST_ARRIVALS_LIMIT = 20;

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildLatestArrivals(items, limit = DEFAULT_LATEST_ARRIVALS_LIMIT) {
  const maxItems = Math.max(0, Number(limit) || 0);
  return [...(Array.isArray(items) ? items : [])]
    .sort((left, right) => (
      timestamp(right?.addedAt) - timestamp(left?.addedAt)
      || String(left?.title || '').localeCompare(
        String(right?.title || ''),
        'it',
        { sensitivity: 'base' },
      )
    ))
    .slice(0, maxItems);
}

module.exports = {
  DEFAULT_LATEST_ARRIVALS_LIMIT,
  buildLatestArrivals,
  timestamp,
};
