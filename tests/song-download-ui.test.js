const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const loader = read('public/js/index-loader.js');
const downloadModule = fs.existsSync(path.join(root, 'public/js/modules/05-playback/19-song-download.js'))
  ? read('public/js/modules/05-playback/19-song-download.js') : '';
const detail = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const search = read('public/js/modules/05-playback/07-search.js');
const queue = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
const index = read('public/index.html');

test('loader includes the song download module after playback URL helpers', () => {
  assert.match(loader, /js\/modules\/05-playback\/19-song-download\.js/);
  assert.ok(loader.indexOf('05-playback/19-song-download.js') > loader.indexOf('05-playback/18-cuefield-automix-integration.js'));
});

test('download module resolves the current quality and calls the desktop bridge', () => {
  assert.match(downloadModule, /resolveAlbumGaplessPlaybackData/);
  assert.match(downloadModule, /getProviderPlaybackQuality/);
  assert.match(downloadModule, /desktopWindow\.downloadSong/);
  assert.match(downloadModule, /showToast/);
});

test('download actions exist for current, detail, search, and queue songs', () => {
  assert.match(index, /onclick="downloadCurrentSong\(\)"/);
  assert.match(detail, /downloadDetailSong\(/);
  assert.doesNotMatch(detail, /onclick="downloadDetailSong\(song\)"/);
  assert.match(search, /downloadSearchResult\(/);
  assert.match(queue, /downloadQueueIndex\(/);
});

test('local songs exit before the desktop download call and busy state is cleared', () => {
  assert.match(downloadModule, /type\s*===\s*['"]local['"]/);
  assert.match(downloadModule, /localUrl/);
  assert.match(downloadModule, /finally\s*\(/);
  assert.match(downloadModule, /downloadBusy/);
});
