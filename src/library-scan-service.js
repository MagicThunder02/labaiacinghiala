// Il vecchio servizio di scansione è mantenuto solo come shim di compatibilità.
// Non registra cronologie e non scopre nuovi file.
const { reconcileLibraryAvailability } = require('./services/library-reconciliation-service');

let reconciliationPromise = null;

function isScanning() {
  return Boolean(reconciliationPromise);
}

async function runTrackedScan() {
  if (reconciliationPromise) return reconciliationPromise;
  reconciliationPromise = reconcileLibraryAvailability();
  try {
    return await reconciliationPromise;
  } finally {
    reconciliationPromise = null;
  }
}

module.exports = { isScanning, runTrackedScan };
