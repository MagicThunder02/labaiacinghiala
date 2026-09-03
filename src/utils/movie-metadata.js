const GENRE_ALIASES = new Map([
  ['action', 'Azione'], ['azione', 'Azione'],
  ['adventure', 'Avventura'], ['avventura', 'Avventura'],
  ['animation', 'Animazione'], ['animazione', 'Animazione'],
  ['biography', 'Biografico'], ['biografico', 'Biografico'],
  ['comedy', 'Commedia'], ['commedia', 'Commedia'],
  ['crime', 'Crime'], ['crimine', 'Crime'], ['poliziesco', 'Crime'],
  ['documentary', 'Documentario'], ['documentario', 'Documentario'],
  ['drama', 'Drammatico'], ['drammatico', 'Drammatico'],
  ['family', 'Famiglia'], ['famiglia', 'Famiglia'],
  ['fantasy', 'Fantasy'],
  ['science fiction', 'Fantascienza'], ['sci fi', 'Fantascienza'],
  ['sci-fi', 'Fantascienza'], ['scifi', 'Fantascienza'], ['fantascienza', 'Fantascienza'],
  ['war', 'Guerra'], ['guerra', 'Guerra'],
  ['horror', 'Horror'], ['mystery', 'Mistero'], ['mistero', 'Mistero'],
  ['music', 'Musicale'], ['musical', 'Musicale'], ['musicale', 'Musicale'],
  ['romance', 'Romantico'], ['romantico', 'Romantico'],
  ['history', 'Storico'], ['historical', 'Storico'], ['storico', 'Storico'],
  ['sport', 'Sport'], ['thriller', 'Thriller'], ['western', 'Western'],
]);

function normalizeGenreKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeGenres(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[,;/|]+/);
  const output = [];
  const seen = new Set();
  for (const value of list) {
    const trimmed = String(value || '').trim();
    if (!trimmed) continue;
    const alias = GENRE_ALIASES.get(normalizeGenreKey(trimmed));
    const genre = alias || trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    const key = genre.toLocaleLowerCase('it');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(genre);
  }
  return output.sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
}

module.exports = { normalizeGenres };
