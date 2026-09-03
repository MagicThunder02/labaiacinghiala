const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const configSource = fs.readFileSync(path.join(projectRoot, 'src', 'config.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'src', 'server.js'), 'utf8');
const envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');

test('Node resta vincolato a 127.0.0.1 anche come configurazione predefinita', () => {
  assert.match(configSource, /const NODE_LOOPBACK_HOST = '127\.0\.0\.1';/);
  assert.match(configSource, /host: configuredHost/);
  assert.match(envExample, /^HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(envExample, /^HOST=0\.0\.0\.0$/m);
  assert.match(serverSource, /app\.listen\(config\.port, config\.host,/);
});

test('Node rifiuta esplicitamente un HOST non loopback', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./src/config')"],
    {
      cwd: projectRoot,
      env: { ...process.env, HOST: '0.0.0.0' },
      encoding: 'utf8',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /HOST deve essere 127\.0\.0\.1/);
});
