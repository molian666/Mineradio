const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const kugouApi = require('../kugou-api');

const appRoot = path.resolve(__dirname, '..');
const shellSource = fs.readFileSync(
  path.join(appRoot, 'public/js/modules/06-lyrics/01-playlist-panel-shell.js'),
  'utf8'
);
const shelfSource = fs.readFileSync(
  path.join(appRoot, 'public/js/modules/04-shelf/01-manager-core.js'),
  'utf8'
);
const kugouApiSource = fs.readFileSync(path.join(appRoot, 'kugou-api.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) {
      return vm.runInNewContext(`(${source.slice(start, i + 1)})`);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

test('failed Kugou catalog response preserves the last successful rows', () => {
  const applyResult = extractFunction(shellSource, 'applyPlaylistCatalogSyncResult');
  const previous = [{ id: 'old', provider: 'kugou' }];
  const result = applyResult(previous, {
    provider: 'kugou',
    loggedIn: true,
    playbackReady: true,
    playlists: [],
    error: 'KUGOU_PLAYLIST_FAILED',
  });

  assert.deepEqual(result.rows, previous);
  assert.equal(result.synced, false);
  assert.equal(result.error, 'KUGOU_PLAYLIST_FAILED');
});

test('invalid Kugou catalog response preserves the last successful rows', () => {
  const applyResult = extractFunction(shellSource, 'applyPlaylistCatalogSyncResult');
  const previous = [{ id: 'old', provider: 'kugou' }];

  assert.deepEqual(applyResult(previous, null).rows, previous);
  assert.deepEqual(applyResult(previous, { provider: 'kugou' }).rows, previous);
  assert.equal(applyResult(previous, { provider: 'kugou' }).synced, false);
});

test('successful Kugou catalog response replaces rows, including a valid empty result', () => {
  const applyResult = extractFunction(shellSource, 'applyPlaylistCatalogSyncResult');
  const result = applyResult([{ id: 'old' }], {
    provider: 'kugou',
    loggedIn: true,
    playbackReady: true,
    playlists: [],
  });

  assert.deepEqual(result.rows, []);
  assert.equal(result.synced, true);
  assert.equal(result.error, '');
});

test('recognized Kugou account can synchronize its catalog before playback token is ready', () => {
  const ready = extractFunction(shellSource, 'kugouPlaylistSyncReady');

  assert.equal(ready({ loggedIn: true, playbackKeyReady: true }), true);
  assert.equal(ready({ loggedIn: true, playbackReady: false, playbackKeyReady: false }), true);
  assert.equal(ready({ loggedIn: false, playbackKeyReady: true }), false);
});

test('Kugou sync retries only when ready and missing or previously failed', () => {
  const shouldRefresh = extractFunction(shellSource, 'kugouPlaylistCatalogNeedsRefresh');
  const ready = { loggedIn: true, playbackKeyReady: true };
  const incomplete = { loggedIn: true, playbackKeyReady: false };

  assert.equal(shouldRefresh(ready, false, false), true);
  assert.equal(shouldRefresh(ready, true, true), true);
  assert.equal(shouldRefresh(ready, true, false), false);
  assert.equal(shouldRefresh(incomplete, false, true), true);
});

test('force-refresh clears provider catalogs before rebuilding the non-merged directory', () => {
  assert.match(
    shellSource,
    /if \(force && playlistCatalogProviderLoggedIn\(provider\)\) setPlaylistCatalogProviderArray\(provider, \[\]\);/
  );
  assert.match(shellSource, /if \(!restoredMergedCache\) userPlaylists = \[\];/);
});

test('Kugou playlist diagnostics cover every sync boundary without logging credentials', () => {
  assert.match(kugouApiSource, /\[KugouPlaylistSync\]\[backend\] login-status/);
  assert.match(kugouApiSource, /\[KugouPlaylistSync\]\[backend\] request/);
  assert.match(kugouApiSource, /\[KugouPlaylistSync\]\[backend\] parsed/);
  assert.match(kugouApiSource, /\[KugouPlaylistSync\]\[backend\] failed/);
  assert.match(shellSource, /\[KugouPlaylistSync\]\[renderer\] refresh-start/);
  assert.match(shellSource, /\[KugouPlaylistSync\]\[renderer\] response/);
  assert.match(shellSource, /\[KugouPlaylistSync\]\[renderer\] catalog-rebuilt/);
  assert.match(shelfSource, /\[KugouPlaylistSync\]\[shelf\] rebuilt/);

  const diagnosticLines = [kugouApiSource, shellSource, shelfSource]
    .flatMap(source => source.split(/\r?\n/))
    .filter(line => line.includes('[KugouPlaylistSync]'))
    .join('\n');
  assert.doesNotMatch(diagnosticLines, /auth\.token|cookie\s*[:,]/i);
});

test('Kugou catalog parser accepts nested gateway playlist collections', () => {
  const extract = kugouApi._test.extractKugouGatewayPlaylistLists;
  assert.equal(typeof extract, 'function');

  const rows = extract({
    info: {
      list: {
        info: [{ listid: 'k-1', listname: '酷狗歌单', song_count: 4 }]
      }
    }
  });

  assert.deepEqual(rows.map(row => row.listid), ['k-1']);
});

test('Kugou provider code 20017 requires playlist-session reauthentication', () => {
  const classify = kugouApi._test.classifyKugouPlaylistSessionFailure;
  const result = classify(
    { loggedIn: true, playbackReady: true },
    { message: 'KUGOU_GATEWAY_FAILED', body: { status: 0, error_code: 20017 } }
  );

  assert.deepEqual(result, {
    validated: false,
    playlistReady: false,
    reauthRequired: true,
    providerErrorCode: 20017,
    error: 'KUGOU_SESSION_REJECTED',
  });
});

test('Kugou transport failures stay retryable without forcing reauthentication', () => {
  const classify = kugouApi._test.classifyKugouPlaylistSessionFailure;
  const result = classify(
    { loggedIn: true, playbackReady: true },
    new Error('ETIMEDOUT')
  );

  assert.equal(result.reauthRequired, false);
  assert.equal(result.providerErrorCode, 0);
  assert.equal(result.error, 'ETIMEDOUT');
});

test('Kugou provider code 20017 is read from an HTTP JSON error body', () => {
  const classify = kugouApi._test.classifyKugouPlaylistSessionFailure;
  const result = classify(
    { loggedIn: true, playbackReady: true },
    { message: 'HTTP 403', body: '{"status":0,"error_code":20017}' }
  );

  assert.equal(result.reauthRequired, true);
  assert.equal(result.providerErrorCode, 20017);
  assert.equal(result.error, 'KUGOU_SESSION_REJECTED');
});

test('Kugou backend diagnostics do not log remote error text', () => {
  const start = kugouApiSource.indexOf("console.warn('[KugouPlaylistSync][backend] failed'");
  const end = kugouApiSource.indexOf('\n    });', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(kugouApiSource.slice(start, end), /failure\.error|err\.message/);
});

test('Kugou delete requests preserve the playlist version returned by the gateway', () => {
  const extractVersion = kugouApi._test.extractKugouListVersion;
  const buildBody = kugouApi._test.buildKugouDeleteSongBody;

  assert.equal(typeof extractVersion, 'function');
  assert.equal(typeof buildBody, 'function');
  const version = extractVersion({ data: { info: { list_ver: '27' } } });
  assert.equal(version, 27);

  const body = buildBody({ listId: '123', userId: '456', token: 'session', fileId: '9007199254740993', listVersion: version });
  assert.equal(body.list_ver, 27);
  assert.equal(body.data[0].fileid, '9007199254740993');

  const collectionBody = buildBody({
    listId: 'collection_3_1271078698_2_0',
    userId: '456',
    token: 'session',
    fileId: '321',
    listVersion: 63,
  });
  assert.equal(collectionBody.listid, 2);
  assert.equal(collectionBody.data[0].fileid, 321);
});

test('Kugou delete code 30203 is exposed as an actionable playlist mutation error', () => {
  const classify = kugouApi._test.classifyKugouPlaylistMutationFailure;
  assert.equal(typeof classify, 'function');

  const result = classify({ message: 'KUGOU_GATEWAY_FAILED', body: { status: 0, error_code: 30203 } });
  assert.deepEqual(result, {
    providerErrorCode: 30203,
    error: 'KUGOU_PLAYLIST_REMOVE_UNSUPPORTED',
    message: '酷狗不允许从该歌单移除歌曲，请确认这是自己创建的歌单',
  });
});

test('Kugou playlist removal does not reuse a file id cached from another playlist', () => {
  const start = kugouApiSource.indexOf('async function findKugouFavoriteFileId(');
  const end = kugouApiSource.indexOf('\n}\n\nfunction classifyKugouPlaylistMutationFailure', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(kugouApiSource.slice(start, end), /kugouLikeFileIdByHash\.has\(hash\)/);
});
