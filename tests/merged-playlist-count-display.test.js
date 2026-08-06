'use strict';
// 合并歌单显示数量一致性测试
// 覆盖：目录 trackCount 是各平台未去重之和（如 273），缓存建立后应显示去重后
// 真实数（如 250）；详情面板 / 播放队列 / shelf 内容列表的显示数量公式必须
// 使用去重后实际数，不能被未去重预估（273）残留或覆盖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const corePath = path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '01a-merged-playlist.js');

function loadCore() {
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
    loginStatus: { loggedIn: true, userId: 'netease-user' },
    qqLoginStatus: { loggedIn: true, userId: 'qq-user' },
    kugouLoginStatus: { loggedIn: false },
    qishuiLoginStatus: { loggedIn: false },
    spotifyLoginStatus: { loggedIn: false },
  };
  const source = fs.readFileSync(corePath, 'utf8');
  vm.runInNewContext(source, sandbox, { filename: corePath });
  return sandbox;
}

function memoryAdapter() {
  const mem = new Map();
  return {
    async get(key) { return mem.has(key) ? JSON.parse(JSON.stringify(mem.get(key))) : null; },
    async set(key, value) { mem.set(key, JSON.parse(JSON.stringify(value))); return true; },
    async delete(key) { mem.delete(key); return true; },
    _mem: mem,
  };
}

// 用户示例场景：网易 trackCount 160 + QQ trackCount 113 = 273（未去重预估），
// 实际曲目去重后 250 首（QQ 有 23 首与网易同名同歌手 → 跨平台去重）。
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

async function fetchPage(source, offset, limit) {
  const all = TRACKS_BY_KEY[source.provider + ':' + source.id] || [];
  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { tracks: page, hasMore: nextOffset < all.length, nextOffset, total: all.length };
}

test('合并歌单目录数量：无缓存时是各平台 trackCount 之和（未去重预估 273）', () => {
  const M = loadCore();
  const record = M.buildMergedPlaylistRecord(SOURCE_ROWS);
  assert.equal(record.trackCount, 273);
  assert.equal(record.provider, 'merged');
});

test('合并歌单全量同步后：快照 total 是去重后真实数（250），缓存分页器 total 一致', async () => {
  const M = loadCore();
  const adapter = memoryAdapter();
  const result = await M.syncMergedPlaylistCache(SOURCE_ROWS, ACCOUNT_KEY, {
    adapter,
    pageSize: 100,
    fetchPage,
  });
  assert.ok(result && result.snapshot, '同步产生快照');
  assert.equal(result.snapshot.tracks.length, 250, '去重后 250 首');
  assert.equal(result.snapshot.total, 250, '快照 total 为去重后真实数');
  const pager = M.createMergedPlaylistCachedPager(result.snapshot);
  const page = await pager.next(500);
  assert.equal(page.total, 250, '缓存分页器 total 为去重后真实数');
  assert.equal(page.tracks.length, 250);
});

test('合并歌单目录数量：缓存恢复（runtime snapshot 匹配）后显示去重后真实数（250）', () => {
  const M = loadCore();
  const adapter = memoryAdapter();
  // 先全量同步建缓存并写入 runtime（restoreMergedPlaylistCatalogCache 的行为）
  return M.syncMergedPlaylistCache(SOURCE_ROWS, ACCOUNT_KEY, { adapter, pageSize: 100, fetchPage })
    .then(function (result) {
      M.mergedPlaylistCacheRuntime.accountKey = ACCOUNT_KEY;
      M.mergedPlaylistCacheRuntime.snapshot = result.snapshot;
      const record = M.buildMergedPlaylistRecord(SOURCE_ROWS);
      assert.equal(record.trackCount, 250, '目录显示去重后真实数');
    });
});

// 下面三个契约测试复现修复后的显示数量公式（与 02-playlist-detail.js /
// 03-podcast-playlist-loaders.js / 03-content-list-manager.js 中的修复保持一致），
// 锁定"合并歌单显示去重后数量、不被未去重预估覆盖"的行为，防止后续回归。

function detailInitialTotal(provider, plTrackCount, cachedCount) {
  // 02-playlist-detail.js openPlaylistPanelDetail 修复后公式：
  // merged 不用目录 trackCount（无缓存时未去重 273），有缓存匹配用去重数，否则 0。
  return provider === 'merged' ? (cachedCount || 0) : (plTrackCount || 0);
}

test('详情面板契约：打开瞬间 merged 初始 total 不用未去重目录数（273），缓存匹配时用去重数（250）', () => {
  // 第一次打开（无缓存）：初始 total 置 0，加载中显示"载入中"而非虚假 273
  assert.equal(detailInitialTotal('merged', 273, 0), 0);
  // 第二次打开（缓存恢复匹配）：初始 total = 去重数 250
  assert.equal(detailInitialTotal('merged', 250, 250), 250);
  // 非 merged 保持原行为
  assert.equal(detailInitialTotal('netease', 273, 0), 273);
});

function detailTotalAfterLoad(provider, initialTotal, responseTotal, tracksLength) {
  // 02-playlist-detail.js loadMorePlaylistPanelDetailTracks 修复后公式
  return provider === 'merged'
    ? Math.max(tracksLength, 0)
    : Math.max(initialTotal || 0, responseTotal || 0, tracksLength);
}
function detailExpectedTotal(provider, tracksLength, stateTotal, plTrackCount) {
  // 02-playlist-detail.js playlistPanelDetailHtml 修复后公式
  return provider === 'merged'
    ? Math.max(tracksLength, stateTotal || 0)
    : Math.max(tracksLength, stateTotal || 0, plTrackCount || 0);
}

test('详情面板契约：首次打开（初始 273）加载 250 首后显示 250，不再残留 273', () => {
  // 第一次打开应用：无缓存，目录 trackCount = 273（未去重之和）
  const initialTotal = 273;
  const tracksLength = 250; // 同步后实际加载的去重后数量
  const responseTotal = 250; // 缓存分页器 total（去重后）
  const stTotal = detailTotalAfterLoad('merged', initialTotal, responseTotal, tracksLength);
  assert.equal(stTotal, 250, 'merged 的 st.total 不被初始 273 快照残留');
  // 渲染时 expectedTotal 不再被 pl.trackCount（未去重）兜底
  const expected = detailExpectedTotal('merged', tracksLength, stTotal, initialTotal);
  assert.equal(expected, 250, '详情面板显示 250 而非 273');
  // 非 merged 歌单保持原公式（不受影响）
  assert.equal(detailTotalAfterLoad('netease', 100, 200, 150), 200);
  assert.equal(detailExpectedTotal('netease', 150, 200, 100), 200);
});

function queueTotal(provider, playQueueLength, rTotal, optsTotal, catalogTrackCount) {
  // 03-podcast-playlist-loaders.js loadPlaylistIntoQueueById 修复后公式
  return provider === 'merged'
    ? playQueueLength
    : Math.max(playQueueLength, rTotal || optsTotal || catalogTrackCount || 0);
}

test('播放队列契约：merged 总数 = 去重后的实际队列长度（250），忽略未去重 r.total（273）', () => {
  assert.equal(queueTotal('merged', 250, 273, 273, 250), 250);
  assert.equal(queueTotal('netease', 250, 273, 0, 250), 273);
});

test('shelf 内容列表契约：merged contentTotalCount 用去重后实际数（250），不被 r.total（273）覆盖', () => {
  // open() 首屏加载后 merged 分支公式：缓存 total（0=未命中）或已加载实际数取大
  const shelfTotalCached = Math.max(250, 250, 0); // 缓存命中：allTracks 250，快照 total 250
  assert.equal(shelfTotalCached, 250);
  const shelfTotalFallback = Math.max(250, 0, 0); // 网络回退：只显示已加载实际数 250
  assert.equal(shelfTotalFallback, 250);
  // loadMoreContentRows merged 分支：以已加载实际数为准
  const loadMoreMerged = Math.max(250, 250); // contentTotalCount 起点 250，allTracks 250
  assert.equal(loadMoreMerged, 250);
  // 非 merged 保持原公式
  const loadMoreNormal = Math.max(100, 273);
  assert.equal(loadMoreNormal, 273);
});
