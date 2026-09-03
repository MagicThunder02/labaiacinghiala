'use strict';

function normalizeCatalogSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenSearchValues(values, output = []) {
  for (const value of Array.isArray(values) ? values : [values]) {
    if (Array.isArray(value)) flattenSearchValues(value, output);
    else if (value !== null && value !== undefined) output.push(String(value));
  }
  return output;
}

function matchesCatalogSearch(search, values) {
  const query = normalizeCatalogSearch(search);
  if (!query) return true;

  const haystack = normalizeCatalogSearch(flattenSearchValues(values).join(' '));
  return query.split(' ').every((term) => haystack.includes(term));
}

module.exports = {
  matchesCatalogSearch,
  normalizeCatalogSearch,
};
