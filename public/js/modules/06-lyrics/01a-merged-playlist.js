var MERGED_PLAYLIST_PROVIDER = 'merged';
var MERGED_PLAYLIST_ID = 'all';
var MERGED_PLAYLIST_CACHE_VERSION = 1;
var MERGED_PLAYLIST_CACHE_DB_NAME = 'mineradio-merged-playlist-cache-v1';
var MERGED_PLAYLIST_CACHE_STORE_NAME = 'snapshots';
var MERGED_PLAYLIST_ACCOUNT_KEY_STORE_KEY = 'mineradio-merged-playlist-account-key-v1';
var mergedPlaylistIndexedDbPromise = null;
var mergedPlaylistCacheRuntime = { accountKey: '', snapshot: null, adapter: null, promise: null, preparePromise: null };

function mergedPlaylistCacheKey(accountKey) {
  return 'merged:' + String(accountKey || 'anonymous');
}

function mergedSourceKey(source) {
  source = source || {};
  return String(source.provider || '') + ':' + String(source.id || '');
}

function mergedSourceSignature(source) {
  source = source || {};
  var revision = source.updatedAt || source.updateTime || source.updated_at || source.modifiedAt || source.modified_at || source.version || source.revision || source.etag || source.lastModified || '';
  return JSON.stringify([
    String(source.provider || ''),
    String(source.id || ''),
    Math.max(0, Number(source.trackCount) || 0),
    String(revision || '')
  ]);
}

function cloneMergedTrack(track) {
  return track && typeof track === 'object' ? Object.assign({}, track) : null;
}

function mergedSourceRecord(source, tracks) {
  source = source || {};
  var record = {
    provider: String(source.provider || ''),
    id: String(source.id || ''),
    name: source.name || '',
    trackCount: Math.max(0, Number(source.trackCount) || 0),
    cover: source.cover || '',
    creator: source.creator || '',
    subscribed: !!source.subscribed,
    signature: source.signature || mergedSourceSignature(source),
    tracks: (tracks || []).map(cloneMergedTrack).filter(Boolean),
  };
  // 保留 revision 字段，保证从缓存恢复（restoreMergedPlaylistCatalogCache →
  // buildMergedPlaylistRecord）后 mergedSourceSignature 能重建出与保存时一致
  // 的签名；否则签名比较永远认为源已变更，导致每次打开都全量重新拉取。
  ['updatedAt', 'updateTime', 'updated_at', 'modifiedAt', 'modified_at', 'version', 'revision', 'etag', 'lastModified']
    .forEach(function (field) {
      if (source[field] != null) record[field] = source[field];
    });
  return record;
}

function normalizeMergedCacheSnapshot(snapshot, accountKey) {
  snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  var sources = Array.isArray(snapshot.sources) ? snapshot.sources.map(function (source) {
    return mergedSourceRecord(source, source && source.tracks);
  }).filter(function (source) { return source.provider && source.id; }) : [];
  var tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks.map(cloneMergedTrack).filter(Boolean) : [];
  return {
    version: MERGED_PLAYLIST_CACHE_VERSION,
    accountKey: String(snapshot.accountKey || accountKey || 'anonymous'),
    sources: sources,
    tracks: tracks,
    total: Math.max(tracks.length, Number(snapshot.total) || 0),
    partial: !!snapshot.partial,
    errors: Array.isArray(snapshot.errors) ? snapshot.errors.map(function (error) { return Object.assign({}, error); }) : [],
    savedAt: Number(snapshot.savedAt) || 0,
  };
}

function createMergedPlaylistCacheAdapter(storage) {
  storage = storage || {};
  return {
    async load(key) {
      if (typeof storage.get !== 'function') return null;
      var value = await storage.get(key);
      return value ? normalizeMergedCacheSnapshot(value, String(key || '').replace(/^merged:/, '')) : null;
    },
    async save(key, snapshot) {
      if (typeof storage.set !== 'function') return false;
      await storage.set(key, normalizeMergedCacheSnapshot(snapshot, String(key || '').replace(/^merged:/, '')));
      return true;
    },
    async remove(key) {
      if (typeof storage.delete !== 'function') return false;
      await storage.delete(key);
      return true;
    },
  };
}

function mergedIndexedDb() {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

function openMergedPlaylistIndexedDb() {
  if (mergedPlaylistIndexedDbPromise) return mergedPlaylistIndexedDbPromise;
  var idb = mergedIndexedDb();
  if (!idb || typeof idb.open !== 'function') return Promise.reject(new Error('INDEXED_DB_UNAVAILABLE'));
  mergedPlaylistIndexedDbPromise = new Promise(function (resolve, reject) {
    var request = idb.open(MERGED_PLAYLIST_CACHE_DB_NAME, 1);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(MERGED_PLAYLIST_CACHE_STORE_NAME)) db.createObjectStore(MERGED_PLAYLIST_CACHE_STORE_NAME);
    };
    request.onsuccess = function () { resolve(request.result); };
    // 打开失败（含 blocked）时重置 promise，允许后续重试；否则一次失败
    // 会让合并歌单缓存永久读写失败，导致每次打开都全量重新拉取。
    function fail(reason) {
      mergedPlaylistIndexedDbPromise = null;
      reject(reason || new Error('INDEXED_DB_OPEN_FAILED'));
    }
    request.onerror = function () { fail(request.error || new Error('INDEXED_DB_OPEN_FAILED')); };
    request.onblocked = function () { fail(new Error('INDEXED_DB_OPEN_BLOCKED')); };
  });
  return mergedPlaylistIndexedDbPromise;
}

function createMergedPlaylistIndexedDbAdapter() {
  return createMergedPlaylistCacheAdapter({
    async get(key) {
      var db = await openMergedPlaylistIndexedDb();
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(MERGED_PLAYLIST_CACHE_STORE_NAME, 'readonly');
        var request = transaction.objectStore(MERGED_PLAYLIST_CACHE_STORE_NAME).get(key);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('INDEXED_DB_READ_FAILED')); };
        transaction.onabort = function () { reject(transaction.error || new Error('INDEXED_DB_READ_ABORTED')); };
      });
    },
    async set(key, value) {
      var db = await openMergedPlaylistIndexedDb();
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(MERGED_PLAYLIST_CACHE_STORE_NAME, 'readwrite');
        var request = transaction.objectStore(MERGED_PLAYLIST_CACHE_STORE_NAME).put(value, key);
        request.onsuccess = function () { resolve(true); };
        request.onerror = function () { reject(request.error || new Error('INDEXED_DB_WRITE_FAILED')); };
        transaction.onabort = function () { reject(transaction.error || new Error('INDEXED_DB_WRITE_ABORTED')); };
      });
    },
    async delete(key) {
      var db = await openMergedPlaylistIndexedDb();
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(MERGED_PLAYLIST_CACHE_STORE_NAME, 'readwrite');
        var request = transaction.objectStore(MERGED_PLAYLIST_CACHE_STORE_NAME).delete(key);
        request.onsuccess = function () { resolve(true); };
        request.onerror = function () { reject(request.error || new Error('INDEXED_DB_DELETE_FAILED')); };
        transaction.onabort = function () { reject(transaction.error || new Error('INDEXED_DB_DELETE_ABORTED')); };
      });
    },
  });
}

function mergedPlaylistFileBridge() {
  if (typeof window === 'undefined' || !window.desktopWindow || !window.desktopWindow.mergedCache) return null;
  return window.desktopWindow.mergedCache;
}

function createMergedPlaylistFileAdapter(bridge) {
  bridge = bridge || mergedPlaylistFileBridge();
  if (!bridge || typeof bridge.read !== 'function') return null;
  return createMergedPlaylistCacheAdapter({
    async get(key) {
      try {
        var result = await bridge.read(key);
        return result && result.ok && result.hit ? result.value : null;
      } catch (e) { return null; }
    },
    async set(key, value) {
      var result = await bridge.write(key, value);
      if (!result || !result.ok) throw new Error('MERGED_CACHE_WRITE_FAILED');
      return true;
    },
    async delete(key) {
      var result = await bridge.remove(key);
      if (!result || !result.ok) throw new Error('MERGED_CACHE_DELETE_FAILED');
      return true;
    },
  });
}

function getMergedPlaylistCacheAdapter() {
  if (!mergedPlaylistCacheRuntime.adapter) {
    // 本地文件缓存优先：打开合并歌单时纯本地读取，不依赖登录态时序与
    // IndexedDB 可用性，避免每次打开都因缓存 miss 触发全量网络拉取。
    // 非 Electron 环境或桥接不可用时回退 IndexedDB。
    mergedPlaylistCacheRuntime.adapter = createMergedPlaylistFileAdapter() || createMergedPlaylistIndexedDbAdapter();
  }
  return mergedPlaylistCacheRuntime.adapter;
}

function dedupeMergedTrackLists(sourceRows) {
  var seenProviderIds = Object.create(null);
  var seenMetaKeys = Object.create(null);
  var tracks = [];
  (sourceRows || []).forEach(function (source) {
    (source && source.tracks || []).forEach(function (track) {
      if (!track) return;
      var normalized = cloneMergedTrack(track);
      if (!normalized.provider) normalized.provider = source.provider;
      var providerId = mergedTrackProviderId(normalized);
      var providerKey = providerId ? normalized.provider + ':' + providerId : '';
      var metaKey = mergedTrackMetaKey(normalized);
      if ((providerKey && seenProviderIds[providerKey]) || (metaKey && seenMetaKeys[metaKey])) return;
      if (providerKey) seenProviderIds[providerKey] = true;
      if (metaKey) seenMetaKeys[metaKey] = true;
      tracks.push(normalized);
    });
  });
  return tracks;
}

function mergeMergedPlaylistSnapshot(previous, sourceRows, changedSourceTracks, accountKey, errors) {
  previous = normalizeMergedCacheSnapshot(previous, accountKey);
  changedSourceTracks = changedSourceTracks || Object.create(null);
  var currentSources = (sourceRows || []).filter(function (source) { return source && source.provider && source.id != null; }).map(function (source) {
    var key = mergedSourceKey(source);
    var hasChangedTracks = Object.prototype.hasOwnProperty.call(changedSourceTracks, key);
    var old = previous.sources.find(function (item) { return mergedSourceKey(item) === key; });
    return mergedSourceRecord(source, hasChangedTracks ? changedSourceTracks[key] : (old && old.tracks || []));
  });
  var currentKeys = Object.create(null);
  currentSources.forEach(function (source) { currentKeys[mergedSourceKey(source)] = true; });
  var retainedErrors = (previous.errors || []).filter(function (error) {
    var key = mergedSourceKey(error);
    return currentKeys[key] && !Object.prototype.hasOwnProperty.call(changedSourceTracks, key);
  });
  var allErrors = retainedErrors.concat(errors || []);
  var tracks = dedupeMergedTrackLists(currentSources);
  return {
    version: MERGED_PLAYLIST_CACHE_VERSION,
    accountKey: String(accountKey || previous.accountKey || 'anonymous'),
    sources: currentSources,
    tracks: tracks,
    total: tracks.length,
    partial: allErrors.length > 0,
    errors: allErrors,
    savedAt: Date.now(),
  };
}

async function fetchAllMergedSourceTracks(source, fetchPage, pageSize) {
  var tracks = [];
  var offset = 0;
  var limit = Math.max(1, Number(pageSize) || 100);
  while (true) {
    var page = await fetchPage(source, offset, limit) || {};
    var rawTracks = Array.isArray(page.tracks) ? page.tracks : [];
    rawTracks.forEach(function (track) {
      var normalized = cloneMergedTrack(track);
      if (normalized) {
        if (!normalized.provider) normalized.provider = source.provider;
        tracks.push(normalized);
      }
    });
    var nextOffset = Math.max(offset, Number(page.nextOffset) || offset + rawTracks.length);
    if (!page.hasMore || !rawTracks.length || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return tracks;
}

async function syncMergedPlaylistCache(sourceRows, accountKey, options) {
  options = options || {};
  var key = mergedPlaylistCacheKey(accountKey);
  var adapter = options.adapter || getMergedPlaylistCacheAdapter();
  var previous = options.previousSnapshot || null;
  if (!previous && adapter && typeof adapter.load === 'function') {
    try { previous = await adapter.load(key); } catch (e) { previous = null; }
  }
  previous = previous ? normalizeMergedCacheSnapshot(previous, accountKey) : null;
  var rows = (sourceRows || []).filter(function (source) { return source && source.provider && source.id != null; });
  if (!rows.length && previous) {
    // sources 为空（如合并歌单记录缺失 sources 字段）时不覆盖已有缓存，
    // 避免把完整缓存降级成空快照后，后续打开永远显示空歌单。
    return { snapshot: previous, changed: false, partial: !!previous.partial, errors: previous.errors || [], fetchedSources: [], skipped: 'empty-rows' };
  }
  var oldByKey = Object.create(null);
  (previous && previous.sources || []).forEach(function (source) { oldByKey[mergedSourceKey(source)] = source; });
  var currentKeys = Object.create(null);
  rows.forEach(function (source) { currentKeys[mergedSourceKey(source)] = true; });
  var changedRows = rows.filter(function (source) {
    var old = oldByKey[mergedSourceKey(source)];
    // 与 mergedSourceRecord 保存签名的方式对称：源自带 signature 优先，
    // 否则重建。保证缓存恢复后的比较结果与保存时完全一致。
    var currentSignature = source.signature || mergedSourceSignature(source);
    if (!old) return true;
    if (old.signature === currentSignature) {
      // 签名未变：仅当上次同步该源失败（partial）时重试拉取，避免不完整
      // 的缓存因签名未变而永远停留在缺失状态（新收藏的歌曲永远进不来）。
      return (previous && previous.errors || []).some(function (error) {
        return mergedSourceKey(error) === mergedSourceKey(source);
      });
    }
    // 签名变化：不直接全量重拉。部分平台的 updatedAt/etag/revision 等
    // 元数据字段每次请求都会变化，若签名一变就重拉，会导致每次打开合并
    // 歌单都重新拉取全部源（表现为歌曲数量每次都不稳定）。
    // 仅在 trackCount 变化，或缓存超过最大寿命（默认 6 小时）时才重拉；
    // 其余情况沿用旧曲目并更新签名，避免元数据抖动触发全量重拉。
    var oldCount = Math.max(0, Number(old.trackCount) || 0);
    var newCount = Math.max(0, Number(source.trackCount) || 0);
    if (newCount !== oldCount) return true;
    var staleAfterMs = Math.max(0, Number(options.staleAfterMs) || 0) || 6 * 60 * 60 * 1000;
    var savedAt = Number(previous && previous.savedAt) || 0;
    if (!savedAt || Date.now() - savedAt > staleAfterMs) return true;
    return false;
  });
  var structureChanged = !previous || rows.length !== previous.sources.length || (previous.sources || []).some(function (source) { return !currentKeys[mergedSourceKey(source)]; });
  var changed = structureChanged || changedRows.length > 0;
  if (!changed) {
    writeMergedPlaylistAccountKey(accountKey);
    return { snapshot: previous, changed: false, partial: !!previous.partial, errors: previous.errors || [], fetchedSources: [] };
  }
  var changedTracks = Object.create(null);
  var errors = [];
  var fetchedSources = [];
  // 多个源并行拉取（小并发），避免全部串行等待把一次全量同步拖到分钟级。
  // 每个源内部的分页仍是串行，保证单平台歌曲顺序稳定。
  var concurrency = Math.min(3, Math.max(1, Number(options.concurrency) || 3));
  var nextSourceIndex = 0;
  async function fetchChangedSource() {
    while (nextSourceIndex < changedRows.length) {
      var index = nextSourceIndex;
      nextSourceIndex += 1;
      var source = changedRows[index];
      var sourceKey = mergedSourceKey(source);
      try {
        changedTracks[sourceKey] = await fetchAllMergedSourceTracks(source, options.fetchPage, options.pageSize);
        fetchedSources.push(sourceKey);
      } catch (error) {
        errors.push({ provider: source.provider, id: source.id, error: error && error.message || String(error) });
      }
    }
  }
  var workerCount = Math.min(concurrency, changedRows.length);
  var workers = [];
  for (var w = 0; w < workerCount; w += 1) workers.push(fetchChangedSource());
  await Promise.all(workers);
  var snapshot = mergeMergedPlaylistSnapshot(previous, rows, changedTracks, accountKey, errors);
  var persisted = false;
  try {
    if (adapter && typeof adapter.save === 'function') persisted = await adapter.save(key, snapshot);
  } catch (e) {
    persisted = false;
  }
  if (persisted) writeMergedPlaylistAccountKey(accountKey);
  console.log('[MergedPlaylistCache] sync', key, 'changed=', changed, 'sources=', rows.length, 'tracks=', snapshot.tracks.length, 'errors=', snapshot.errors.length, 'persisted=', persisted, 'fetched=', fetchedSources.length);
  return { snapshot: snapshot, changed: true, partial: snapshot.partial, errors: snapshot.errors, fetchedSources: fetchedSources, persisted: persisted };
}

function createMergedPlaylistCachedPager(snapshot) {
  snapshot = normalizeMergedCacheSnapshot(snapshot, snapshot && snapshot.accountKey);
  var tracks = snapshot.tracks.slice();
  var offset = 0;
  return {
    next: async function (limit) {
      limit = Math.max(1, Number(limit) || 1);
      var pageTracks = tracks.slice(offset, offset + limit);
      offset += pageTracks.length;
      return {
        tracks: pageTracks,
        total: tracks.length,
        nextOffset: offset,
        hasMore: offset < tracks.length,
        partial: !!snapshot.partial,
        errors: offset === pageTracks.length ? snapshot.errors.slice() : [],
        cached: true,
      };
    },
  };
}

async function loadMergedPlaylistCache(accountKey, adapter) {
  adapter = adapter || getMergedPlaylistCacheAdapter();
  var key = mergedPlaylistCacheKey(accountKey);
  try {
    var snapshot = adapter && typeof adapter.load === 'function' ? await adapter.load(key) : null;
    if (!snapshot) {
      var rememberedKey = readMergedPlaylistAccountKey();
      if (rememberedKey && rememberedKey !== String(accountKey || 'anonymous')) {
        // anonymous 时也允许用记住的 key 兜底读取：启动早期登录态尚未
        // 恢复时 accountKey 可能是 anonymous，若不兜底则缓存永远 MISS。
        var compatible = String(accountKey || 'anonymous') === 'anonymous'
          ? true
          : mergedPlaylistAccountKeysCompatible(accountKey, rememberedKey);
        if (compatible) {
          snapshot = await adapter.load(mergedPlaylistCacheKey(rememberedKey));
          if (snapshot) console.log('[MergedPlaylistCache] load compat-key', key, '<-', rememberedKey, snapshot.tracks.length + ' tracks');
        }
      }
    }
    if (snapshot) {
      mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
      mergedPlaylistCacheRuntime.snapshot = normalizeMergedCacheSnapshot(snapshot, accountKey);
    }
    if (!snapshot) console.log('[MergedPlaylistCache] load MISS', key);
    return snapshot;
  } catch (e) {
    console.warn('[MergedPlaylistCache] load failed', key, e && e.message || e);
    return null;
  }
}

// 使合并歌单缓存失效：清除内存快照并删除持久化缓存。
// 收藏/喜欢等会改变源歌单内容的操作成功后调用，保证下次加载
// 合并歌单时重新同步（而不是继续读旧快照）。
async function invalidateMergedPlaylistCache(accountKey, adapter) {
  accountKey = String(accountKey || '');
  mergedPlaylistCacheRuntime.accountKey = '';
  mergedPlaylistCacheRuntime.snapshot = null;
  adapter = adapter || getMergedPlaylistCacheAdapter();
  try {
    if (adapter && typeof adapter.remove === 'function') {
      await adapter.remove(mergedPlaylistCacheKey(accountKey));
    }
  } catch (e) { }
}

function readMergedPlaylistAccountKey() {
  try {
    return String(localStorage.getItem(MERGED_PLAYLIST_ACCOUNT_KEY_STORE_KEY) || '').trim();
  } catch (e) { return ''; }
}

function writeMergedPlaylistAccountKey(accountKey) {
  try { localStorage.setItem(MERGED_PLAYLIST_ACCOUNT_KEY_STORE_KEY, String(accountKey || '')); } catch (e) { }
}

function mergedPlaylistAccountKeyParts(accountKey) {
  return String(accountKey || '').split('|').filter(function (part) { return !!part; });
}

function mergedPlaylistAccountKeyIsSubset(subset, superset) {
  var expected = mergedPlaylistAccountKeyParts(subset);
  var available = Object.create(null);
  mergedPlaylistAccountKeyParts(superset).forEach(function (part) { available[part] = true; });
  return expected.length > 0 && expected.every(function (part) { return !!available[part]; });
}

function mergedPlaylistAccountKeysCompatible(first, second) {
  if (!first || !second || first === 'anonymous' || second === 'anonymous') return false;
  return mergedPlaylistAccountKeyIsSubset(first, second) || mergedPlaylistAccountKeyIsSubset(second, first);
}

function currentMergedPlaylistAccountKey() {
  var providers = [
    ['netease', typeof loginStatus !== 'undefined' ? loginStatus : null],
    ['qq', typeof qqLoginStatus !== 'undefined' ? qqLoginStatus : null],
    ['kugou', typeof kugouLoginStatus !== 'undefined' ? kugouLoginStatus : null],
    ['qishui', typeof qishuiLoginStatus !== 'undefined' ? qishuiLoginStatus : null],
    ['spotify', typeof spotifyLoginStatus !== 'undefined' ? spotifyLoginStatus : null],
  ];
  var parts = providers.filter(function (item) { return item[1] && item[1].loggedIn; }).map(function (item) {
    var status = item[1];
    var identity = status.userId || status.uid || status.accountId || status.nickname || 'logged-in';
    return item[0] + ':' + String(identity);
  });
  var currentKey = parts.length ? parts.join('|') : 'anonymous';
  if (currentKey === 'anonymous') {
    // 登录态可能尚未恢复完成（启动早期 refreshUserPlaylists 触发缓存恢复
    // 时各平台 loginStatus 还没就绪）。此时用上次记住的账号 key 兜底，
    // 保证合并歌单缓存能命中，而不是退回 anonymous 导致缓存 MISS 后全量
    // 重新拉取。游客（所有平台均未登录）时合并歌单不会展示，不存在串
    // 缓存风险。
    var rememberedKey = readMergedPlaylistAccountKey();
    if (rememberedKey) return rememberedKey;
    return currentKey;
  }
  var rememberedKey = readMergedPlaylistAccountKey();
  if (rememberedKey && rememberedKey !== currentKey && mergedPlaylistAccountKeyIsSubset(currentKey, rememberedKey)) return rememberedKey;
  if (rememberedKey && rememberedKey !== currentKey && mergedPlaylistAccountKeyIsSubset(rememberedKey, currentKey)) return currentKey;
  writeMergedPlaylistAccountKey(currentKey);
  return currentKey;
}

function isMergedPlaylistSource(provider, id) {
  return String(provider || '') === MERGED_PLAYLIST_PROVIDER && String(id || '') === MERGED_PLAYLIST_ID;
}

function normalizeMergedText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·•|/\\()[\]{}:：，,。.!！?？'"“”‘’]/g, '');
}

function mergedTrackProviderId(track) {
  track = track || {};
  return track.providerSongId || track.trackId || track.songId || track.songmid || track.mid || track.id || '';
}

function mergedTrackMetaKey(track) {
  track = track || {};
  var name = track.name || track.title || track.songName || track.songname || '';
  var artist = track.artist || track.artistName || track.singer || track.singerName || '';
  var nameKey = normalizeMergedText(name);
  var artistKey = normalizeMergedText(artist);
  return nameKey && artistKey ? nameKey + '|' + artistKey : '';
}

function buildMergedPlaylistRecord(sourcePlaylists) {
  var sources = (sourcePlaylists || []).filter(function (playlist) {
    return playlist && playlist.provider && playlist.id != null;
  }).map(function (playlist) {
    return {
      provider: String(playlist.provider),
      id: String(playlist.id),
      name: playlist.name || '',
      trackCount: Math.max(0, Number(playlist.trackCount) || 0),
      cover: playlist.cover || '',
      creator: playlist.creator || '',
      subscribed: !!playlist.subscribed,
      signature: playlist.signature || '',
      updatedAt: playlist.updatedAt || '',
      updateTime: playlist.updateTime || '',
      updated_at: playlist.updated_at || '',
      modifiedAt: playlist.modifiedAt || '',
      modified_at: playlist.modified_at || '',
      version: playlist.version || '',
      revision: playlist.revision || '',
      etag: playlist.etag || '',
      lastModified: playlist.lastModified || '',
    };
  });
  var trackCount = sources.reduce(function (sum, playlist) { return sum + playlist.trackCount; }, 0);
  // 合并歌单已同步过（缓存存在且账号/源一致）时，目录数量显示去重后的
  // 真实歌曲数，避免"各平台 trackCount 之和"（未去重预估，如 273）与歌单
  // 内实际数量（去重后，如 250）不一致。
  var cachedCount = mergedPlaylistCachedTrackCountFor(sourcePlaylists);
  if (cachedCount > 0) trackCount = cachedCount;
  return {
    provider: MERGED_PLAYLIST_PROVIDER,
    id: MERGED_PLAYLIST_ID,
    name: '跨平台合并歌单',
    source: MERGED_PLAYLIST_PROVIDER,
    virtual: true,
    trackCount: trackCount,
    cover: (sources.find(function (playlist) { return playlist.cover; }) || {}).cover || '',
    creator: sources.length + ' 个平台',
    sources: sources,
  };
}

function mergedPlaylistCachedTrackCountFor(sourcePlaylists) {
  var snapshot = mergedPlaylistCacheRuntime.snapshot;
  if (!snapshot || !Array.isArray(snapshot.sources)) return 0;
  if (mergedPlaylistCacheRuntime.accountKey !== String(currentMergedPlaylistAccountKey() || '')) return 0;
  var rows = (sourcePlaylists || []).filter(function (playlist) {
    return playlist && playlist.provider && playlist.id != null;
  });
  if (!rows.length || rows.length !== snapshot.sources.length) return 0;
  var snapshotKeys = Object.create(null);
  (snapshot.sources || []).forEach(function (source) { snapshotKeys[mergedSourceKey(source)] = true; });
  for (var i = 0; i < rows.length; i += 1) {
    if (!snapshotKeys[mergedSourceKey(rows[i])]) return 0;
  }
  return Math.max(0, Number(snapshot.total) || (snapshot.tracks || []).length || 0);
}

function playlistCatalogView(sourcePlaylists, enabled) {
  var rows = Array.isArray(sourcePlaylists) ? sourcePlaylists : [];
  return enabled ? (rows.length ? [buildMergedPlaylistRecord(rows)] : []) : rows.slice();
}

function createMergedPlaylistPager(sources, fetchPage) {
  var sourceRows = (sources || []).filter(function (source) {
    return source && source.provider && source.id != null;
  }).map(function (source) { return Object.assign({}, source); });
  var sourceIndex = 0;
  var sourceOffset = 0;
  var loaded = 0;
  var completed = false;
  var seenProviderIds = Object.create(null);
  var seenMetaKeys = Object.create(null);
  var total = sourceRows.reduce(function (sum, source) { return sum + Math.max(0, Number(source.trackCount) || 0); }, 0);

  function result(tracks, errors) {
    return {
      tracks: tracks,
      total: Math.max(total, loaded),
      nextOffset: loaded,
      hasMore: !completed,
      partial: errors.length > 0,
      errors: errors,
    };
  }

  async function next(limit) {
    limit = Math.max(1, Number(limit) || 1);
    if (completed) return result([], []);
    var tracks = [];
    var errors = [];
    while (tracks.length < limit && sourceIndex < sourceRows.length) {
      var source = sourceRows[sourceIndex];
      var page;
      try {
        page = await fetchPage(source, sourceOffset, limit - tracks.length);
      } catch (error) {
        errors.push({ provider: source.provider, id: source.id, error: error && error.message || String(error) });
        sourceIndex += 1;
        sourceOffset = 0;
        continue;
      }
      page = page || {};
      var rawTracks = Array.isArray(page.tracks) ? page.tracks : [];
      var previousOffset = sourceOffset;
      var nextSourceOffset = Math.max(previousOffset, Number(page.nextOffset) || previousOffset + rawTracks.length);
      rawTracks.forEach(function (track) {
        if (!track) return;
        var normalized = Object.assign({}, track);
        if (!normalized.provider) normalized.provider = source.provider;
        var providerId = mergedTrackProviderId(normalized);
        var providerKey = providerId ? normalized.provider + ':' + providerId : '';
        var metaKey = mergedTrackMetaKey(normalized);
        if ((providerKey && seenProviderIds[providerKey]) || (metaKey && seenMetaKeys[metaKey])) return;
        if (providerKey) seenProviderIds[providerKey] = true;
        if (metaKey) seenMetaKeys[metaKey] = true;
        tracks.push(normalized);
      });
      sourceOffset = nextSourceOffset;
      var sourceDone = !page.hasMore || !rawTracks.length || sourceOffset <= previousOffset;
      if (sourceDone) {
        sourceIndex += 1;
        sourceOffset = 0;
      }
    }
    if (sourceIndex >= sourceRows.length) completed = true;
    loaded += tracks.length;
    return result(tracks, errors);
  }

  return { next: next };
}
