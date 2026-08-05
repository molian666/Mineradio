const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'public/js/index-loader.js'), 'utf8');
const modulePath = path.join(root, 'public/js/modules/07-fx/09-download-settings.js');
const moduleSource = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : '';

test('settings markup has a separate song download directory section', () => {
  assert.match(index, /download-storage-panel/);
  assert.match(index, /id="download-storage-root"/);
  assert.match(index, /chooseMineradioDownloadRoot\(\)/);
});

test('download settings module loads and reads the saved path', () => {
  assert.match(loader, /js\/modules\/07-fx\/09-download-settings\.js/);
  assert.match(moduleSource, /refreshMineradioDownloadSettings/);
  assert.match(moduleSource, /getDownloadSettings/);
  assert.match(moduleSource, /download-storage-root/);
});

test('changing the download directory does not write cache settings', () => {
  assert.match(moduleSource, /chooseDownloadDirectory/);
  assert.match(moduleSource, /setDownloadDirectory/);
  assert.doesNotMatch(moduleSource, /setCacheSettings/);
});
