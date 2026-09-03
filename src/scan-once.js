const { reconcileLibraryAvailability } = require('./services/library-reconciliation-service');

reconcileLibraryAvailability()
  .then((result) => {
    console.log(`Verifica libreria completata: ${result.checked} record controllati, ${result.unavailable} nuovi non disponibili, ${result.restored} ripristinati.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Verifica libreria non riuscita:', error);
    process.exit(1);
  });
