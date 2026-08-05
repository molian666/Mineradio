const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');

test('main process registers the four song download IPC channels', () => {
  for (const channel of [
    'mineradio-download-get-settings',
    'mineradio-download-choose-directory',
    'mineradio-download-set-directory',
    'mineradio-download-song',
  ]) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\(['"]${channel}['"]`));
  }
});

test('main process isolates download settings and uses the local audio proxy', () => {
  assert.match(mainSource, /song-download/);
  assert.match(mainSource, /download-settings\.json/);
  assert.match(mainSource, /\/api\/audio\?url=/);
  assert.match(mainSource, /127\.0\.0\.1/);
  assert.match(mainSource, /encodeURIComponent\(/);
});

test('local songs are rejected before the network download service is called', () => {
  assert.match(mainSource, /type\s*===\s*['"]local['"]/);
  assert.match(mainSource, /source\s*===\s*['"]local['"]/);
  assert.match(mainSource, /localUrl/);
});

test('preload exposes only the narrow download bridge methods', () => {
  assert.match(preloadSource, /getDownloadSettings\s*:/);
  assert.match(preloadSource, /chooseDownloadDirectory\s*:/);
  assert.match(preloadSource, /setDownloadDirectory\s*:/);
  assert.match(preloadSource, /downloadSong\s*:/);
  assert.match(preloadSource, /ipcRenderer\.invoke\(['"]mineradio-download-song['"]/);
});
