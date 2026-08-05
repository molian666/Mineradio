const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('desktop packaging includes the LX runtime required by the main process', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const files = packageJson.build?.files || [];

  assert.ok(files.includes('.mineradio-lx-addon/**/*'));
  assert.equal(
    fs.existsSync(path.join(projectRoot, '.mineradio-lx-addon', 'runtime', 'user-api-main.js')),
    true
  );
});
