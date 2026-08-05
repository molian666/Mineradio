const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const corePath = path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '01a-merged-playlist.js');

function loadCore(options) {
  options = options || {};
  const storage = options.localStorage || new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    localStorage,
  };
  Object.assign(sandbox, options.statuses || {});
  const source = fs.existsSync(corePath) ? fs.readFileSync(corePath, 'utf8') : '';
  vm.runInNewContext(source, sandbox, { filename: corePath });
  return sandbox;
}

function source(provider, id, name, trackCount, cover) {
  return { provider, id, name, trackCount, cover: cover || '', creator: provider + ' user' };
}

test('builds one stable virtual record and switches the visible catalog', () => {
  const core = loadCore();
  const rows = [
    source('netease', 'n-1', '网易歌单', 12, 'netease-cover'),
    source('spotify', 's-1', 'Spotify歌单', 8, 'spotify-cover'),
  ];

  const merged = core.buildMergedPlaylistRecord(rows);

  assert.equal(merged.provider, 'merged');
  assert.equal(merged.id, 'all');
  assert.equal(merged.virtual, true);
  assert.equal(merged.trackCount, 20);
  assert.equal(merged.name, '跨平台合并歌单');
  assert.equal(merged.cover, 'netease-cover');
  assert.deepEqual(Array.from(merged.sources, item => [item.provider, item.id]), [
    ['netease', 'n-1'],
    ['spotify', 's-1'],
  ]);
  assert.deepEqual(Array.from(core.playlistCatalogView(rows, false)), rows);
  assert.equal(core.playlistCatalogView(rows, true).length, 1);
  assert.equal(core.playlistCatalogView(rows, true)[0].id, merged.id);
  assert.deepEqual(Array.from(core.playlistCatalogView([], true)), []);
});

test('pages sources in order, deduplicates cross-provider tracks, and continues after a source failure', async () => {
  const core = loadCore();
  const rows = [
    source('netease', 'n-1', '网易歌单', 2),
    source('qq', 'q-1', 'QQ歌单', 2),
    source('kugou', 'k-1', '酷狗歌单', 1),
    source('spotify', 's-1', 'Spotify歌单', 1),
  ];
  const calls = [];
  const pager = core.createMergedPlaylistPager(rows, async (item, offset, limit) => {
    calls.push([item.provider, item.id, offset, limit]);
    if (item.provider === 'netease') {
      return {
        tracks: [
          { provider: 'netease', id: 'n-song-1', name: 'Same Song', artist: 'Same Artist' },
          { provider: 'netease', id: 'n-song-2', name: 'Netease Only', artist: 'N Artist' },
        ],
        total: 2,
        nextOffset: 2,
        hasMore: false,
      };
    }
    if (item.provider === 'qq') {
      return {
        tracks: [
          { provider: 'qq', id: 'q-song-1', name: 'Same Song', artist: 'Same Artist' },
          { provider: 'qq', id: 'q-song-2', name: 'QQ Only', artist: 'Q Artist' },
        ],
        total: 2,
        nextOffset: 2,
        hasMore: false,
      };
    }
    if (item.provider === 'kugou') throw new Error('Kugou unavailable');
    return {
      tracks: [{ provider: 'spotify', id: 's-song-1', name: 'Spotify Only', artist: 'S Artist' }],
      total: 1,
      nextOffset: 1,
      hasMore: false,
    };
  });

  const first = await pager.next(2);
  assert.deepEqual(Array.from(first.tracks, track => track.id), ['n-song-1', 'n-song-2']);
  assert.equal(first.partial, false);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.hasMore, true);

  const second = await pager.next(2);
  assert.deepEqual(Array.from(second.tracks, track => track.id), ['q-song-2', 's-song-1']);
  assert.equal(second.partial, true);
  assert.deepEqual(Array.from(second.errors, error => error.provider), ['kugou']);
  assert.equal(second.nextOffset, 4);
  assert.equal(second.hasMore, false);

  const done = await pager.next(2);
  assert.equal(done.tracks.length, 0);
  assert.equal(done.hasMore, false);
  assert.equal(calls.some(call => call[0] === 'netease' && call[2] !== 0), false);
});

test('loads the merged helper before detail code and refreshes the catalog when the setting toggles', () => {
  const loader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index-loader.js'), 'utf8');
  const panelShell = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const bindings = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');

  assert.ok(loader.indexOf('js/modules/06-lyrics/01a-merged-playlist.js') < loader.indexOf('js/modules/06-lyrics/02-playlist-detail.js'));
  assert.match(panelShell, /playlistCatalogView\(/);
  assert.match(bindings, /shelfMergeCollections[\s\S]{0,500}rebuildUserPlaylistsFromCatalog\(/);
});

test('routes merged detail and queue loading through a stateful pager', () => {
  const detail = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const queueLoader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');

  assert.match(detail, /createMergedPlaylistPagerForRecord\(/);
  assert.match(detail, /mergedPager/);
  assert.match(detail, /provider === MERGED_PLAYLIST_PROVIDER/);
  assert.match(queueLoader, /raw\.indexOf\('merged:'\) === 0/);
  assert.match(queueLoader, /state\.mergedPager/);
  assert.match(queueLoader, /opts\.mergedPager/);
});

test('keeps the virtual provider identity through the 3D shelf content path', () => {
  const shelf = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');

  assert.match(shelf, /pl\.provider === MERGED_PLAYLIST_PROVIDER/);
  assert.match(shelf, /playlistId: .*merged:/);
  assert.match(content, /mergedPlaylistRecordForId\(/);
  assert.match(content, /playlistId.*indexOf\('merged:'\)/);
});

test('persists merged source snapshots and reloads only changed sources', async () => {
  const core = loadCore();
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const firstRows = [
    source('netease', 'n-1', 'Netease', 2),
    source('qq', 'q-1', 'QQ', 2),
  ];
  const pages = {
    'netease:n-1': [
      { provider: 'netease', id: 'n-1', name: 'First Song', artist: 'Artist' },
      { provider: 'netease', id: 'n-2', name: 'Shared Song', artist: 'Artist' },
    ],
    'qq:q-1': [
      { provider: 'qq', id: 'q-1', name: 'Shared Song', artist: 'Artist' },
      { provider: 'qq', id: 'q-2', name: 'QQ Song', artist: 'Artist' },
    ],
  };
  const calls = [];
  const fetchPage = async (row) => {
    calls.push(row.provider + ':' + row.id);
    const tracks = pages[row.provider + ':' + row.id] || [];
    return { tracks, total: tracks.length, nextOffset: tracks.length, hasMore: false };
  };

  const first = await core.syncMergedPlaylistCache(firstRows, 'account-1', { adapter, fetchPage });
  assert.equal(first.changed, true);
  assert.deepEqual(calls, ['netease:n-1', 'qq:q-1']);
  assert.deepEqual(Array.from(first.snapshot.tracks, track => track.id), ['n-1', 'n-2', 'q-2']);

  calls.length = 0;
  const unchanged = await core.syncMergedPlaylistCache(firstRows, 'account-1', { adapter, fetchPage });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(calls, []);

  calls.length = 0;
  const changedRows = [
    source('netease', 'n-1', 'Netease', 3),
    source('qq', 'q-1', 'QQ', 2),
    source('spotify', 's-1', 'Spotify', 1),
  ];
  pages['netease:n-1'] = [
    { provider: 'netease', id: 'n-1', name: 'First Song', artist: 'Artist' },
    { provider: 'netease', id: 'n-2', name: 'Shared Song', artist: 'Artist' },
    { provider: 'netease', id: 'n-3', name: 'New Song', artist: 'Artist' },
  ];
  pages['spotify:s-1'] = [{ provider: 'spotify', id: 's-1', name: 'Spotify Song', artist: 'Artist' }];
  const changed = await core.syncMergedPlaylistCache(changedRows, 'account-1', { adapter, fetchPage });
  assert.equal(changed.changed, true);
  assert.deepEqual(calls, ['netease:n-1', 'spotify:s-1']);
  assert.deepEqual(Array.from(changed.snapshot.tracks, track => track.id), ['n-1', 'n-2', 'n-3', 'q-2', 's-1']);

  const cached = await adapter.load(core.mergedPlaylistCacheKey('account-1'));
  assert.equal(cached.sources.length, 3);
  assert.equal(cached.sources.some(row => row.provider === 'qq'), true);
  assert.equal((await core.syncMergedPlaylistCache([changedRows[0], changedRows[2]], 'account-1', { adapter, fetchPage })).snapshot.sources.some(row => row.provider === 'qq'), false);
  assert.equal((await adapter.load(core.mergedPlaylistCacheKey('account-2'))), null);
});

test('serves a persisted merged snapshot through pages without refetching sources', async () => {
  const core = loadCore();
  const snapshot = {
    version: 1,
    accountKey: 'account-1',
    sources: [],
    tracks: [
      { provider: 'netease', id: 'n-1', name: 'One', artist: 'A' },
      { provider: 'qq', id: 'q-1', name: 'Two', artist: 'B' },
      { provider: 'spotify', id: 's-1', name: 'Three', artist: 'C' },
    ],
    total: 3,
    partial: false,
    errors: [],
  };
  const pager = core.createMergedPlaylistCachedPager(snapshot);
  const first = await pager.next(2);
  const second = await pager.next(2);
  assert.deepEqual(Array.from(first.tracks, track => track.id), ['n-1', 'q-1']);
  assert.deepEqual(Array.from(second.tracks, track => track.id), ['s-1']);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});

test('uses the persisted snapshot before merged detail and queue source requests', () => {
  const root = path.join(__dirname, '..', 'public', 'js', 'modules');
  const detail = fs.readFileSync(path.join(root, '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const queueLoader = fs.readFileSync(path.join(root, '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const panelShell = fs.readFileSync(path.join(root, '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');

  assert.match(detail, /prepareMergedPlaylistCache\(/);
  assert.match(detail, /createMergedPlaylistCachedPager\(/);
  assert.match(queueLoader, /prepareMergedPlaylistCache\(/);
  assert.match(queueLoader, /createMergedPlaylistCachedPager\(/);
  assert.match(panelShell, /scheduleMergedPlaylistCacheSync\(/);
});

test('keeps cached tracks when only source metadata changes (track counts unchanged)', async () => {
  const core = loadCore();
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const firstRows = [Object.assign(source('netease', 'n-1', 'Netease', 1), { updatedAt: 'v1' })];
  assert.equal(core.buildMergedPlaylistRecord(firstRows).sources[0].updatedAt, 'v1');
  const calls = [];
  const fetchPage = async (row) => {
    calls.push(row.updatedAt || 'none');
    return { tracks: [{ provider: row.provider, id: row.updatedAt, name: row.updatedAt, artist: 'Artist' }], nextOffset: 1, hasMore: false };
  };
  await core.syncMergedPlaylistCache(firstRows, 'account-versions', { adapter, fetchPage });
  calls.length = 0;
  // 平台 updatedAt 抖动（v1 → v2）但 trackCount 未变：不应全量重拉，
  // 否则每次打开合并歌单都会因元数据字段变化重新拉取（歌曲数量不稳定）。
  const changedRows = [Object.assign(source('netease', 'n-1', 'Netease', 1), { updatedAt: 'v2' })];
  const result = await core.syncMergedPlaylistCache(changedRows, 'account-versions', { adapter, fetchPage });
  assert.equal(result.changed, false);
  assert.deepEqual(calls, []);
  assert.equal(result.snapshot.tracks[0].id, 'v1');
});

test('refetches a source when track count changes even if only metadata changed', async () => {
  const core = loadCore();
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const calls = [];
  const fetchPage = async (row) => {
    calls.push(row.updatedAt || 'none');
    return { tracks: [{ provider: row.provider, id: row.updatedAt, name: row.updatedAt, artist: 'Artist' }], nextOffset: 1, hasMore: false };
  };
  await core.syncMergedPlaylistCache([Object.assign(source('netease', 'n-1', 'Netease', 1), { updatedAt: 'v1' })], 'account-versions', { adapter, fetchPage });
  calls.length = 0;
  // trackCount 1 → 3：即使签名/元数据也变化，也必须重拉
  const changedRows = [Object.assign(source('netease', 'n-1', 'Netease', 3), { updatedAt: 'v2' })];
  const result = await core.syncMergedPlaylistCache(changedRows, 'account-versions', { adapter, fetchPage });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, ['v2']);
  assert.equal(result.snapshot.tracks[0].id, 'v2');
});

test('refetches a source when the cache is older than the stale window', async () => {
  const core = loadCore();
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const calls = [];
  const fetchPage = async (row) => {
    calls.push(row.updatedAt || 'none');
    return { tracks: [{ provider: row.provider, id: row.updatedAt, name: row.updatedAt, artist: 'Artist' }], nextOffset: 1, hasMore: false };
  };
  // 构造一个超过默认 6h stale 窗口的旧缓存快照（签名 v1、trackCount 1）
  const oldSnapshot = {
    version: 1,
    accountKey: 'account-versions',
    sources: [Object.assign(source('netease', 'n-1', 'Netease', 1), { updatedAt: 'v1', tracks: [{ provider: 'netease', id: 'v1', name: 'v1', artist: 'Artist' }] })],
    tracks: [{ provider: 'netease', id: 'v1', name: 'v1', artist: 'Artist' }],
    total: 1,
    partial: false,
    errors: [],
    savedAt: Date.now() - 7 * 60 * 60 * 1000,
  };
  // 签名变化且缓存已过期 → 允许重拉
  const changedRows = [Object.assign(source('netease', 'n-1', 'Netease', 1), { updatedAt: 'v2' })];
  const result = await core.syncMergedPlaylistCache(changedRows, 'account-versions', {
    adapter, previousSnapshot: oldSnapshot, fetchPage,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, ['v2']);
});

test('reuses the persisted full account key while login state is still restoring', () => {
  const storage = new Map();
  const complete = loadCore({
    localStorage: storage,
    statuses: {
      loginStatus: { loggedIn: true, userId: 'netease-user' },
      qqLoginStatus: { loggedIn: true, userId: 'qq-user' },
      kugouLoginStatus: { loggedIn: false },
      qishuiLoginStatus: { loggedIn: false },
      spotifyLoginStatus: { loggedIn: false },
    },
  });
  assert.equal(complete.currentMergedPlaylistAccountKey(), 'netease:netease-user|qq:qq-user');

  const restarted = loadCore({
    localStorage: storage,
    statuses: {
      loginStatus: { loggedIn: true, userId: 'netease-user' },
      qqLoginStatus: { loggedIn: false },
    },
  });
  assert.equal(restarted.currentMergedPlaylistAccountKey(), 'netease:netease-user|qq:qq-user');
});

test('migrates a compatible cache when a newly logged-in platform is added', async () => {
  const storage = new Map([['mineradio-merged-playlist-account-key-v1', 'netease:netease-user']]);
  const core = loadCore({
    localStorage: storage,
    statuses: {
      loginStatus: { loggedIn: true, userId: 'netease-user' },
      qqLoginStatus: { loggedIn: true, userId: 'qq-user' },
    },
  });
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const oldRows = [source('netease', 'n-1', 'Netease', 1)];
  await core.syncMergedPlaylistCache(oldRows, 'netease:netease-user', {
    adapter,
    fetchPage: async () => ({ tracks: [{ provider: 'netease', id: 'n-1', name: 'Cached', artist: 'Artist' }], nextOffset: 1, hasMore: false }),
  });

  const accountKey = core.currentMergedPlaylistAccountKey();
  const cached = await core.loadMergedPlaylistCache(accountKey, adapter);
  assert.equal(cached.tracks[0].id, 'n-1');
  const calls = [];
  const result = await core.syncMergedPlaylistCache([
    oldRows[0],
    source('qq', 'q-1', 'QQ', 1),
  ], 'netease:netease-user|qq:qq-user', {
    adapter,
    previousSnapshot: cached,
    fetchPage: async row => {
      calls.push(row.provider);
      return { tracks: [{ provider: row.provider, id: row.provider + '-1', name: row.provider, artist: 'Artist' }], nextOffset: 1, hasMore: false };
    },
  });
  assert.deepEqual(calls, ['qq']);
  assert.deepEqual(Array.from(result.snapshot.tracks, track => track.id), ['n-1', 'qq-1']);
});

test('keeps cached source tracks when an incremental sync fails', async () => {
  const core = loadCore();
  const stored = new Map();
  const adapter = core.createMergedPlaylistCacheAdapter({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, value); },
    async delete(key) { stored.delete(key); },
  });
  const original = source('qq', 'q-1', 'QQ', 1);
  await core.syncMergedPlaylistCache([original], 'account-failure', {
    adapter,
    fetchPage: async () => ({ tracks: [{ provider: 'qq', id: 'q-old', name: 'Old', artist: 'Artist' }], nextOffset: 1, hasMore: false }),
  });
  const changed = Object.assign(source('qq', 'q-1', 'QQ', 2), { updatedAt: 'changed' });
  const result = await core.syncMergedPlaylistCache([changed], 'account-failure', {
    adapter,
    fetchPage: async () => { throw new Error('provider unavailable'); },
  });
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(result.snapshot.tracks, track => track.id), ['q-old']);
  assert.deepEqual(Array.from(result.errors, error => error.provider), ['qq']);
});

test('restores cached merged catalog before provider refresh and syncs stale data in background', () => {
  const panelShell = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const queueLoader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');

  assert.match(panelShell, /restoreMergedPlaylistCatalogCache\(/);
  assert.match(panelShell, /restoredMergedCache/);
  assert.match(panelShell, /!restoredMergedCache[\s\S]{0,240}miniQueueSkeleton/);
  assert.match(queueLoader, /forceSync/);
  assert.match(queueLoader, /preferCache/);
});
