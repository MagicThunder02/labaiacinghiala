// Compatibilità interna con versioni precedenti.
// La discovery del filesystem è stata rimossa: il server verifica solo record già noti a SQLite.
const { SUPPORTED_EXTENSIONS } = require('./media-formats');
const { reconcileLibraryAvailability } = require('./services/library-reconciliation-service');

module.exports = {
  SUPPORTED_EXTENSIONS,
  scanLibrary: reconcileLibraryAvailability,
  reconcileLibraryAvailability,
};
