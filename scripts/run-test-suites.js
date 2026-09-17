'use strict';

const { spawnSync } = require('node:child_process');

const suites = process.argv.slice(2);
if (suites.length === 0) {
  console.error('Specificare almeno uno script npm da eseguire.');
  process.exit(2);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath non disponibile: avviare questo comando tramite npm.');
  process.exit(2);
}

const failures = [];
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [npmCli, 'run', suite], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) failures.push(suite);
}

if (failures.length > 0) {
  console.error(`\nSuite fallite: ${failures.join(', ')}`);
  process.exit(1);
}

console.log(`\nTutte le suite sono passate: ${suites.join(', ')}`);
