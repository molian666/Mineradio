'use strict';
// 合并歌单缓存逻辑回归测试
// 覆盖：首次全量同步并落缓存、未变化不重拉、缓存命中快速开始加载、
// 重启后从 IndexedDB(内存模拟) 恢复、trackCount 变化重拉、
// 签名在缓存序列化/恢复后保持一致、partial 缓存重试失败源。
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

const PLATFORM_TRACKS = {
  'netease:111': [
    { id: 'n1', name: 'N1', artist: 'A' }, { id: 'n2', name: 'N2', artist: 'A' },
    { id: 'n3', name: 'N3', artist: 'A' }, { id: 'n4', name: 'N4', artist: 'A' },
    { id: 'n5', name: 'N5', artist: 'A' }, { id: 'n6', name: 'N6', artist: 'A' },
    { id: 'n7', name: 'N7', artist: 'A' },
  ],
  'qq:222': [
    { id: 'q1', name: 'Q1', artist: 'B' }, { id: 'q2', name: 'Q2', artist: 'B' },
    { id: 'q3', name: 'Q3', artist: 'B' }, { id: 'q4', name: 'Q4', artist: 'B' },
  ],
};

function makeRecord(trackCountN, trackCountQ, withRevision) {
  trackCountN = trackCountN == null ? 7 : trackCountN;
  trackCountQ = trackCountQ == null ? 4 : trackCountQ;
  const netease = { provider: 'netease', id: '111', name: '网易歌单', trackCount: trackCountN };
  const qq = { provider: 'qq', id: '222', name: 'QQ歌单', trackCount: trackCountQ };
  if (withRevision) {
    netease.updatedAt = '2024-01-01';
    qq.updatedAt = '2024-01-02';
  }
  return {
    provider: 'merged', id: 'all', name: '跨平台合并歌单', virtual: true,
    sources: [netease, qq],
  };
}

function makeFetchCounter() {
  const counts = { n: 0, q: 0, failQ: false };
  return {
    counts,
    async fetchPage(source, offset, limit) {
      const key = source.provider + ':' + source.id;
      if (key.startsWith('netease')) counts.n += 1; else counts.q += 1;
      if (key.startsWith('qq') && counts.failQ) throw new Error('QQ_API_DOWN');
      const all = PLATFORM_TRACKS[key] || [];
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return { tracks: page, hasMore: nextOffset < all.length, nextOffset, total: all.length };
    },
  };
}

const accountKey = 'netease:netease-user|qq:qq-user';

test('合并歌单缓存：首次全量同步落缓存，未变化不重拉，命中缓存快速开始加载', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();

  // 首次同步（无 previous）
  const r1 = await M.syncMergedPlaylistCache(makeRecord(7, 4, true).sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r1.changed, true);
  assert.equal(r1.snapshot.tracks.length, 11);
  assert.equal(fc.counts.n, 3, 'netease 3 页');
  assert.equal(fc.counts.q, 2, 'qq 2 页');
  assert.ok(storage._mem.has('merged:' + accountKey), '缓存已写入');
  // 缓存快照保留 revision 字段（签名可重建）
  assert.equal(storage._mem.get('merged:' + accountKey).sources[0].updatedAt, '2024-01-01');

  // 数据未变再次同步 → 不重拉
  const beforeN = fc.counts.n, beforeQ = fc.counts.q;
  const r2 = await M.syncMergedPlaylistCache(makeRecord(7, 4, true).sources, accountKey, {
    adapter, previousSnapshot: r1.snapshot, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r2.changed, false);
  assert.equal(fc.counts.n, beforeN);
  assert.equal(fc.counts.q, beforeQ);

  // 重启后：runtime 清空，从 adapter 读缓存命中
  M.mergedPlaylistCacheRuntime.accountKey = '';
  M.mergedPlaylistCacheRuntime.snapshot = null;
  const loaded = await M.loadMergedPlaylistCache(accountKey, adapter);
  assert.ok(loaded && loaded.tracks.length === 11);
  const beforeN2 = fc.counts.n, beforeQ2 = fc.counts.q;
  const restoredRecord = M.buildMergedPlaylistRecord(loaded.sources.map(s => Object.assign({}, s)));
  // 缓存恢复后签名一致 → 后台同步不重拉
  const r3 = await M.syncMergedPlaylistCache(restoredRecord.sources, accountKey, {
    adapter, previousSnapshot: loaded, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r3.changed, false, '恢复后签名一致，不重拉');
  assert.equal(fc.counts.n, beforeN2);
  assert.equal(fc.counts.q, beforeQ2);
});

test('合并歌单缓存：trackCount 变化只重拉对应源', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();
  const r1 = await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  const beforeN = fc.counts.n, beforeQ = fc.counts.q;
  const r2 = await M.syncMergedPlaylistCache(makeRecord(8, 4).sources, accountKey, {
    adapter, previousSnapshot: r1.snapshot, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r2.changed, true);
  assert.ok(fc.counts.n > beforeN, 'netease 被重拉');
  assert.equal(fc.counts.q, beforeQ, 'qq 未重拉');
});

test('合并歌单缓存：空 sources 不覆盖已有缓存（防御空快照）', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();

  // 首次全量同步落缓存（11 首）
  await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(storage._mem.get('merged:' + accountKey).tracks.length, 11);

  // 合并歌单记录缺失 sources（fallback 对象）→ sync 不应覆盖缓存
  const r = await M.syncMergedPlaylistCache([], accountKey, {
    adapter, previousSnapshot: storage._mem.get('merged:' + accountKey), pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r.skipped, 'empty-rows', '空 sources 被跳过');
  assert.equal(r.snapshot.tracks.length, 11, '缓存保持 11 首');
  assert.equal(storage._mem.get('merged:' + accountKey).tracks.length, 11, '持久化缓存未被覆盖');
  assert.equal(fc.counts.n + fc.counts.q, 5, '未触发任何重新拉取');
});

test('合并歌单缓存：并发打开只触发一次全量同步（防重复拉取）', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();
  // 复刻 03 文件当前版本的 prepareMergedPlaylistCache（含 preparePromise 防重入）
  async function prepareMergedPlaylistCache(record, options) {
    options = options || {};
    record = record || {};
    if (record.provider !== 'merged') return null;
    var accountKey = options.accountKey || M.currentMergedPlaylistAccountKey();
    var forceSync = !!options.forceSync;
    var adapter = options.adapter || M.getMergedPlaylistCacheAdapter();
    if (!forceSync && M.mergedPlaylistCacheRuntime.preparePromise) return M.mergedPlaylistCacheRuntime.preparePromise;
    var op = (async function () {
      var previous = M.mergedPlaylistCacheRuntime.accountKey === String(accountKey || 'anonymous')
        ? M.mergedPlaylistCacheRuntime.snapshot
        : null;
      if (!previous) previous = await M.loadMergedPlaylistCache(accountKey, adapter);
      if (previous && !forceSync) {
        M.mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
        M.mergedPlaylistCacheRuntime.snapshot = previous;
        return { snapshot: previous, changed: false, partial: !!previous.partial, errors: previous.errors || [], cached: true, stale: true };
      }
      if (!previous && !forceSync && M.mergedPlaylistCacheRuntime.promise) return M.mergedPlaylistCacheRuntime.promise;
      var result = await M.syncMergedPlaylistCache(record.sources || [], accountKey, {
        adapter: adapter,
        previousSnapshot: previous,
        pageSize: options.pageSize || 100,
        fetchPage: options.fetchPage,
      });
      if (result && result.snapshot) {
        M.mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
        M.mergedPlaylistCacheRuntime.snapshot = result.snapshot;
      }
      return result;
    })();
    if (!forceSync) {
      M.mergedPlaylistCacheRuntime.preparePromise = op;
      op.finally(function () {
        if (M.mergedPlaylistCacheRuntime.preparePromise === op) M.mergedPlaylistCacheRuntime.preparePromise = null;
      }).catch(function () { });
    }
    return op;
  }
  // 无缓存，两个入口并发打开（详情面板 + 播放入口）
  const [a, b] = await Promise.all([
    prepareMergedPlaylistCache(makeRecord(), { adapter, accountKey, pageSize: 3, fetchPage: fc.fetchPage }),
    prepareMergedPlaylistCache(makeRecord(), { adapter, accountKey, pageSize: 3, fetchPage: fc.fetchPage }),
  ]);
  assert.ok(a && a.snapshot && b && b.snapshot, '两个入口都拿到快照');
  assert.equal(a.snapshot.tracks.length, 11);
  assert.equal(fc.counts.n, 3, 'netease 只拉一次（3 页）');
  assert.equal(fc.counts.q, 2, 'qq 只拉一次（2 页）');
  assert.equal(fc.counts.n + fc.counts.q, 5, '总 fetch 5 次（单次全量）');
});

test('合并歌单：一次加载所有歌曲（loadAll 循环取满分页器）', async () => {
  const M = loadCore();
  // 复刻 03 文件 loadAllMergedPlaylistTracks 的循环逻辑
  async function loadAllMergedPlaylistTracks(pager, batchSize) {
    var all = [];
    var errors = [];
    var partial = false;
    var total = 0;
    var batch = Math.max(1, Number(batchSize) || 200);
    var guard = 0;
    while (pager && typeof pager.next === 'function') {
      guard += 1;
      if (guard > 500) break;
      var page = await pager.next(batch);
      if (!page || typeof page !== 'object') break;
      all.push.apply(all, Array.isArray(page.tracks) ? page.tracks : []);
      errors = errors.concat(Array.isArray(page.errors) ? page.errors : []);
      total = Math.max(total, Number(page.total) || 0, all.length);
      if (page.partial) partial = true;
      if (!page.hasMore) break;
    }
    return { tracks: all, total: Math.max(total, all.length), nextOffset: all.length, hasMore: false, partial: partial || errors.length > 0, errors: errors };
  }
  const fc = makeFetchCounter();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const snap = (await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  })).snapshot;

  // 缓存分页器：一次取完全部 11 首，无网络请求
  const cachedPager = M.createMergedPlaylistCachedPager(snap);
  const fromCache = await loadAllMergedPlaylistTracks(cachedPager, 20);
  assert.equal(fromCache.tracks.length, 11, '缓存分页器一次取完全部');
  assert.equal(fromCache.hasMore, false);
  const fcAfter = { n: fc.counts.n, q: fc.counts.q };
  // 网络分页器：循环拉完所有源所有分页（netease 3 页 + qq 2 页）
  var netFetch = { n: 0, q: 0 };
  const netPager = M.createMergedPlaylistPager(makeRecord().sources, function (source, offset, limit) {
    // 模拟平台接口每页最多返回 3 首（真实平台有页大小限制）
    var key = source.provider + ':' + source.id;
    if (key.startsWith('netease')) netFetch.n += 1; else netFetch.q += 1;
    var all = PLATFORM_TRACKS[key] || [];
    var page = all.slice(offset, offset + Math.min(Math.max(1, Number(limit) || 1), 3));
    var nextOffset = offset + page.length;
    return Promise.resolve({ tracks: page, hasMore: nextOffset < all.length, nextOffset, total: all.length });
  });
  const fromNet = await loadAllMergedPlaylistTracks(netPager, 20);
  assert.equal(fromNet.tracks.length, 11, '网络分页器循环拉完所有源');
  assert.equal(netFetch.n, 3, 'netease 3 页拉完');
  assert.equal(netFetch.q, 2, 'qq 2 页拉完');
  assert.equal(fromNet.hasMore, false);
  // 再次调用网络分页器（已完成）→ 空结果不重复拉取
  const again = await loadAllMergedPlaylistTracks(netPager, 20);
  assert.equal(again.tracks.length, 0, '已完成的网络分页器不再拉取');
});

test('合并歌单缓存：invalidate 清除缓存后下次加载重新同步', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();

  // 首次同步落缓存
  await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.ok(storage._mem.has('merged:' + accountKey), '缓存已写入');

  // 红心成功 → 失效缓存
  await M.invalidateMergedPlaylistCache(accountKey, adapter);
  assert.ok(!storage._mem.has('merged:' + accountKey), '持久化缓存已删除');
  assert.equal(M.mergedPlaylistCacheRuntime.accountKey, '', '内存 accountKey 已清空');
  assert.equal(M.mergedPlaylistCacheRuntime.snapshot, null, '内存快照已清空');
  const afterInvalidate = await M.loadMergedPlaylistCache(accountKey, adapter);
  assert.equal(afterInvalidate, null, '失效后读不到缓存');

  // 再次加载 → 走全量同步（模拟打开合并歌单）
  const beforeN = fc.counts.n, beforeQ = fc.counts.q;
  const again = await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(again.changed, true, '失效后再次同步为全量重拉');
  assert.equal(fc.counts.n, beforeN + 3, 'netease 全量重拉');
  assert.equal(fc.counts.q, beforeQ + 2, 'qq 全量重拉');
  assert.equal(again.snapshot.tracks.length, 11);
  assert.ok(storage._mem.has('merged:' + accountKey), '缓存重新写入');
});

test('合并歌单缓存：partial（部分源失败）下次同步重试失败源并补全', async () => {
  const M = loadCore();
  const storage = memoryAdapter();
  const adapter = M.createMergedPlaylistCacheAdapter(storage);
  const fc = makeFetchCounter();
  fc.counts.failQ = true;

  const r1 = await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r1.partial, true);
  assert.equal(r1.snapshot.tracks.length, 7, '只有 netease 7 首');
  assert.ok(r1.errors.some(e => e.provider === 'qq'), 'errors 记录 qq');

  fc.counts.failQ = false;
  const beforeQ = fc.counts.q;
  const r2 = await M.syncMergedPlaylistCache(makeRecord().sources, accountKey, {
    adapter, previousSnapshot: r1.snapshot, pageSize: 3, fetchPage: fc.fetchPage,
  });
  assert.equal(r2.changed, true, 'partial 缓存再次同步重试失败源');
  assert.ok(fc.counts.q > beforeQ, 'qq 被重新拉取');
  assert.equal(r2.snapshot.tracks.length, 11, '补全为 11 首');
  assert.ok(!r2.errors.some(e => e.provider === 'qq'), 'qq 的 error 被清除');
});
