const db = require('./database');
const { createDirectBootstrapInvite, directBootstrapFromEnvironment } = require('./direct-bootstrap');
const {
  DEFAULT_INVITE_MINUTES,
  MAX_INVITE_MINUTES,
  PairingError,
  createPairingInvite,
  listPairedDevices,
  revokePairedDevice,
} = require('./services/pairing-service');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printUsage() {
  console.log(`Comandi pairing Baia:

  npm run pairing -- invite [--minutes ${DEFAULT_INVITE_MINUTES}] [--direct-endpoint https://host:443 --server-fingerprint SHA256:...]
  npm run pairing -- devices
  npm run pairing -- revoke <device-id>

Gli inviti sono bearer secret monouso: condividili solo con il dispositivo da associare.`);
}

function formatState(device) {
  return device.revokedAt ? `REVOCATO ${device.revokedAt}` : 'ATTIVO';
}

function main() {
  const command = process.argv[2];

  if (command === 'invite') {
    const minutesValue = valueAfter('--minutes');
    const minutes = minutesValue === undefined ? DEFAULT_INVITE_MINUTES : Number(minutesValue);
    const invite = createPairingInvite(db, { ttlMinutes: minutes });

    console.log('\nInvito Baia creato.');
    console.log(`Scadenza: ${invite.expiresAt}`);
    console.log('\nTOKEN locale/legacy (mostrato solo ora):');
    console.log(invite.token);

    const directEndpoint = valueAfter('--direct-endpoint');
    const serverFingerprint = valueAfter('--server-fingerprint');
    let directBootstrap = null;
    if (directEndpoint || serverFingerprint) {
      if (!directEndpoint || !serverFingerprint) {
        throw new PairingError('INVALID_REQUEST', '--direct-endpoint e --server-fingerprint devono essere forniti insieme.');
      }
      directBootstrap = createDirectBootstrapInvite({
        inviteToken: invite.token,
        connectorEndpoint: directEndpoint,
        serverFingerprint,
      });
    } else {
      directBootstrap = directBootstrapFromEnvironment(invite.token);
    }
    if (directBootstrap) {
      console.log('\nBOOTSTRAP DIRECT INTERNET (usa questo nell’app Baia):');
      console.log(directBootstrap);
    }
    console.log('\nNon pubblicare il token/bootstrap e non salvarlo in file di configurazione condivisi.\n');
    return;
  }

  if (command === 'devices') {
    const devices = listPairedDevices(db);
    if (!devices.length) {
      console.log('Nessun dispositivo associato.');
      return;
    }

    for (const device of devices) {
      console.log(`${device.id}  ${formatState(device)}`);
      console.log(`  Nome: ${device.deviceName}`);
      console.log(`  Fingerprint: ${device.fingerprint}`);
      console.log(`  Installazione: ${device.installationId}`);
    }
    return;
  }

  if (command === 'revoke') {
    const deviceId = process.argv[3];
    if (!deviceId) {
      printUsage();
      process.exitCode = 2;
      return;
    }
    revokePairedDevice(db, deviceId);
    console.log(`Dispositivo revocato: ${deviceId}`);
    return;
  }

  printUsage();
  if (command) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  if (error instanceof PairingError) {
    console.error(`Errore pairing: ${error.message}`);
    if (String(error.message).includes('durata')) {
      console.error(`Valore consentito: 1-${MAX_INVITE_MINUTES} minuti.`);
    }
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  try { db.close(); } catch {}
}
