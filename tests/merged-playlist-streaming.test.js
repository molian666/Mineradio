'use strict';
// 合并歌单首次打开流式加载测试
// 覆盖：prepareMergedPlaylistCache({stream:true}) 缓存 miss 时不阻塞（立即返回
// streaming 标记），后台同步异步完成并写缓存（下次打开秒开）；详情面板 / 播放队列 /
// shelf 使用单页拉取 + 自动连续调度（不再等全量同步、不依赖滚动到底部）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'public', 'js', 'modules');
const corePath = path.join(root, '06-lyrics', '01a-merged-playlist.js');
const loadersPath = path.join(root, '06-lyrics', '03-podcast-playlist-loaders.js');
const detailPath = path.join(root, '06-lyrics', '02-playlist-detail.js');
const shelfPath = path.join(root, '04-shelf', '03-content-list-manager.js');

// 网易 trackCount 160 + QQ trackCount 113 = 273（未去重预估），去重后 250 首
const NETEASE_TRACKS = [];
for (let i = 0; i < 160; i += 1) NETEASE_TRACKS.push({ id: 'n' + i, name: 'N' + i, artist: 'A' });
const QQ_TRACKS = [];
for (let i = 0; i < 23; i += 1) QQ_TRACKS.push({ id: 'q' + i, name: 'N' + i, artist: 'A' }); // 与网易前 23 首同名同歌手
for (let i = 23; i < 113; i += 1) QQ_TRACKS.push({ id: 'q' + i, name: 'Q' + i, artist: 'B' });
const TRACKS_BY_KEY = { 'netease:111': NETEASE_TRACKS, 'qq:222': QQ_TRACKS };

const SOURCE_ROWS = [
  { provider: 'netease', id: '111', name: '网易歌单', trackCount: 160 },
  { provider: 'qq', id: '222', name: 'QQ歌单', trackCount: 113 },
];
const ACCOUNT_KEY = 'netease:netease-user|qq:qq-user';

function memoryAdapter() {
  const mem = new Map();
  return {
    async get(key) { return mem.has(key) ? JSON.parse(JSON.stringify(mem.get(key))) : null; },
    async set(key, value) { mem.set(key, JSON.parse(JSON.stringify(value))); return true; },
    async delete(key) { mem.delete(key); return true; },
    _mem: mem,
  };
}

// 加载 01a + 03 两个模块到同一 sandbox（03 的 prepareMergedPlaylistCache 依赖 01a 的
// 缓存函数；apiJson / playlistTracksEndpoint / 目录相关函数用 stub 提供）。
function loadEnvironment() {
  const storage = new Map();
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
    indexedDB: undefined,
    document: { getElementById: function () { return null; } },
    loginStatus: { loggedIn: true, userId: 'netease-user' },
    qqLoginStatus: { loggedIn: true, userId: 'qq-user' },
    kugouLoginStatus: { loggedIn: false },
    qishuiLoginStatus: { loggedIn: false },
    spotifyLoginStatus: { loggedIn: false },
    fx: { shelfMergeCollections: true },
    userPlaylists: [],
    playlistCatalogRevision: 0,
    renderUserPlaylistsList: function () { },
    playlistCatalogHasPendingPages: function () { return false; },
    playlistCatalogSyncState: { providers: {} },
    playlistTracksEndpoint: function (provider, id, params) {
      return '/test/' + provider + '/' + id + '?offset=' + (params && params.offset || 0) + '&limit=' + (params && params.limit || 100);
    },
    apiJson: async function (url) {
      const m = /^\/test\/(\w+)\/([^?]+)\?offset=(\d+)&limit=(\d+)$/.exec(String(url));
      if (!m) return {};
      const all = TRACKS_BY_KEY[m[1] + ':' + m[2]] || [];
      const offset = Number(m[3]);
      const limit = Number(m[4]);
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return { tracks: page, nextOffset, hasMore: nextOffset < all.length, total: all.length };
    },
  };
  vm.runInNewContext(fs.readFileSync(corePath, 'utf8'), sandbox, { filename: corePath });
  vm.runInNewContext(fs.readFileSync(loadersPath, 'utf8'), sandbox, { filename: loadersPath });
  return sandbox;
}

test('合并歌单流式：缓存 miss 时 stream 立即返回 streaming 标记，不阻塞等全量同步', async () => {
  const M = loadEnvironment();
  const adapter = M.createMergedPlaylistCacheAdapter(memoryAdapter());
  const t0 = Date.now();
  const result = await M.prepareMergedPlaylistCache(
    { provider: 'merged', id: 'all', sources: SOURCE_ROWS },
    { stream: true, adapter }
  );
  assert.equal(result.streaming, true, '返回 streaming 标记');
  assert.equal(result.snapshot, null, '不返回快照（调用方改用网络分页器流式拉取）');
  assert.equal(result.cached, false);
  assert.ok(Date.now() - t0 < 200, '同步在后台执行，prepare 不阻塞');
});

test('合并歌单流式：后台同步异步完成并写缓存（下次打开可命中）', async () => {
  const M = loadEnvironment();
  const adapter = M.createMergedPlaylistCacheAdapter(memoryAdapter());
  const result = await M.prepareMergedPlaylistCache(
    { provider: 'merged', id: 'all', sources: SOURCE_ROWS },
    { stream: true, adapter }
  );
  assert.equal(result.streaming, true);
  assert.ok(M.mergedPlaylistCacheRuntime.promise, '后台同步已启动');
  await M.mergedPlaylistCacheRuntime.promise; // 等待后台同步完成
  const cached = await adapter.load(M.mergedPlaylistCacheKey(ACCOUNT_KEY));
  assert.ok(cached, '缓存已写入');
  assert.equal(cached.total, 250, '缓存为去重后真实数');
  assert.equal((cached.tracks || []).length, 250);
  assert.equal(M.mergedPlaylistCacheRuntime.promise, null, '后台同步结束后 promise 复位');
});

test('合并歌单流式：已有缓存时 stream 仍直接返回快照（不进入流式，秒开）', async () => {
  const M = loadEnvironment();
  const adapter = M.createMergedPlaylistCacheAdapter(memoryAdapter());
  // 先建缓存（等价于上次打开已完成同步）
  await M.syncMergedPlaylistCache(SOURCE_ROWS, ACCOUNT_KEY, { adapter, pageSize: 100, fetchPage: (function () {
    return async function (source, offset, limit) {
      const all = TRACKS_BY_KEY[source.provider + ':' + source.id] || [];
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return { tracks: page, hasMore: nextOffset < all.length, nextOffset, total: all.length };
    };
  })() });
  const result = await M.prepareMergedPlaylistCache(
    { provider: 'merged', id: 'all', sources: SOURCE_ROWS },
    { stream: true, adapter }
  );
  assert.equal(result.cached, true, '缓存命中');
  assert.equal(result.streaming, undefined, '不进流式模式');
  assert.ok(result.snapshot && result.snapshot.total === 250, '直接返回去重后快照');
});

test('流式加载路径：详情面板 / 播放队列 / shelf 均使用单页拉取与自动连续调度', () => {
  const detail = fs.readFileSync(detailPath, 'utf8');
  const queueLoader = fs.readFileSync(loadersPath, 'utf8');
  const shelf = fs.readFileSync(shelfPath, 'utf8');

  // 详情面板：prepare 带 stream，单页拉取（fetchMergedPlaylistPage），自动继续调度
  assert.match(detail, /prepareMergedPlaylistCache\([^)]*stream:\s*true/);
  assert.match(detail, /await fetchMergedPlaylistPage\(st\.mergedPager, PLAYLIST_DETAIL_BATCH_SIZE\)/);
  assert.match(detail, /loadMorePlaylistPanelDetailTracks\('warm'\)/);

  // 播放队列：prepare 带 stream，首次单页拉取，hydration 自动继续
  assert.match(queueLoader, /prepareMergedPlaylistCache\([^)]*stream:\s*true/);
  assert.match(queueLoader, /await fetchMergedPlaylistPage\(mergedPager, playlistQueuePageSize\(source\.provider, true\)\)/);
  assert.match(queueLoader, /merged-auto-hydrate/);

  // shelf：prepare 带 stream，loadMore 后自动继续 warm 拉取
  assert.match(shelf, /prepareMergedPlaylistCache\([^)]*stream:\s*true/);
  assert.match(shelf, /scheduleContentWarmPrefetch\(token\)/);
});
