var podcastListEl = document.getElementById('podcast-list');
if (podcastListEl) {
  podcastListEl.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('[data-podcast-back]')) {
      renderMyPodcastCollections({ animate: true });
      return;
    }
    var radioCard = e.target && e.target.closest ? e.target.closest('[data-podcast-radio-id]') : null;
    if (radioCard) {
      loadPodcastRadioIntoQueue(radioCard.getAttribute('data-podcast-radio-id'), true, radioCard.getAttribute('data-podcast-title') || '');
      return;
    }
    var card = e.target && e.target.closest ? e.target.closest('[data-podcast-key]') : null;
    if (!card) return;
    openMyPodcastCollection(card.getAttribute('data-podcast-key'), card.getAttribute('data-podcast-title') || '');
  });
}
function renderMyPodcastRadioItems(key, title, items) {
  var $pod = document.getElementById('podcast-list');
  if (!$pod) return;
  if (!items.length) {
    $pod.innerHTML = '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title || '我的播客') + '</div><button class="fx-mini-btn ghost" data-podcast-back="1" style="height:24px;padding:0 9px;font-size:10.5px">返回</button></div>' +
      '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>';
    return;
  }
  $pod.innerHTML = '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title || '我的播客') + '</div><button class="fx-mini-btn ghost" data-podcast-back="1" style="height:24px;padding:0 9px;font-size:10.5px">返回</button></div>' +
    items.map(function (r) {
      var thumb = r.cover ? coverUrlWithSize(r.cover, 88) : '';
      var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>';
      return '<div class="pl-card podcast-card podcast-child" data-podcast-radio-id="' + escHtml(String(r.id || r.radioId || '')) + '" data-podcast-title="' + escHtml(r.name || '') + '">' +
        imgTag +
        '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(r.name || '') + '</div><div class="pl-sub">' + escHtml((r.djName || r.artist || 'Podcast') + (r.programCount ? (' · ' + r.programCount + ' 集') : '')) + '</div></div>' +
        '</div>';
    }).join('');
  animateVisiblePanelList($pod, '.pl-card', document.getElementById('playlist-panel'));
}
async function openMyPodcastCollection(key, title) {
  if (!key) return;
  showLoading();
  try {
    var r = await apiJson('/api/podcast/my/items?key=' + encodeURIComponent(key) + '&limit=' + PLAYLIST_LAZY_BATCH_SIZE);
    if (r && r.loggedIn === false) { showLoginModal(); return; }
    var items = r.items || [];
    myPodcastItems[key] = items;
    if (!items.length) {
      showToast('暂无内容: ' + (title || key));
      renderMyPodcastRadioItems(key, title, []);
      return;
    }
    if (r.itemType === 'voice' || (items[0] && items[0].type === 'podcast')) {
      playQueue = items.map(cloneSong);
      currentIdx = 0;
      safeRenderQueuePanel('podcast-collection-voice');
      safeSwitchPlaylistTab('queue', 'podcast-collection-voice');
      safeShelfRebuild('podcast-collection-voice', true);
      forcePlaybackControlsInteractive();
      await playQueueAt(0);
      showToast('载入: ' + (title || '喜欢的声音'));
      return;
    }
    renderMyPodcastRadioItems(key, title, items);
  } catch (e) {
    console.warn(e);
    showToast('播客加载失败');
  } finally {
    hideLoading();
  }
}
async function loadPodcastRadioIntoQueue(id, autoplay, title) {
  if (!id) return;
  showLoading();
  try {
    var r = await apiJson('/api/podcast/programs?id=' + encodeURIComponent(id) + '&limit=' + PLAYLIST_LAZY_BATCH_SIZE);
    if (r.error) { showToast('播客加载失败: ' + r.error); return; }
    if (!r.programs || !r.programs.length) { showToast('播客暂无可播放节目'); return; }
    playQueue = r.programs.map(cloneSong);
    currentIdx = 0;
    safeRenderQueuePanel('podcast-radio');
    safeSwitchPlaylistTab('queue', 'podcast-radio');
    safeShelfRebuild('podcast-radio', true);
    forcePlaybackControlsInteractive();
    if (autoplay) await playQueueAt(0);
    showToast('载入: ' + (title || '播客'));
  } catch (e) {
    console.warn(e);
    showToast('播客加载失败');
  } finally {
    hideLoading();
  }
}
function playlistQueueSource(id) {
  var raw = String(id || '');
  if (raw.indexOf('merged:') === 0) return { provider: MERGED_PLAYLIST_PROVIDER, id: raw.slice(7), requestId: raw };
  if (raw.indexOf('qq:') === 0) return { provider: 'qq', id: raw.slice(3), requestId: raw };
  if (raw.indexOf('kugou:') === 0) return { provider: 'kugou', id: raw.slice(6), requestId: raw };
  if (raw.indexOf('qishui:') === 0) return { provider: 'qishui', id: raw.slice(7), requestId: raw };
  if (raw.indexOf('spotify:') === 0) return { provider: 'spotify', id: raw.slice(8), requestId: raw };
  return { provider: 'netease', id: raw, requestId: raw };
}
function playlistQueuePageSize(provider, initial) {
  if (provider === MERGED_PLAYLIST_PROVIDER) return initial ? PLAYLIST_QUEUE_INITIAL_BATCH_SIZE : PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE;
  if (initial) return provider === 'kugou' || provider === 'qishui' ? 50 : (provider === 'spotify' ? 96 : PLAYLIST_QUEUE_INITIAL_BATCH_SIZE);
  if (provider === 'kugou' || provider === 'qishui') return 50;
  if (provider === 'spotify') return 100;
  if (provider === 'qq') return 96;
  return PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE;
}
function playlistQueuePageUrl(source, offset, limit) {
  if (source && source.provider === MERGED_PLAYLIST_PROVIDER) return '';
  return playlistTracksEndpoint(source.provider, source.id, { offset: Math.max(0, offset || 0), limit: Math.max(1, limit || PLAYLIST_QUEUE_INITIAL_BATCH_SIZE) });
}
function mergedPlaylistRecordForId(id) {
  var key = String(id || '');
  return (userPlaylists || []).find(function (playlist) {
    return playlist && playlist.provider === MERGED_PLAYLIST_PROVIDER && String(playlist.id || '') === key;
  }) || null;
}
// 合并歌单同步/恢复后，把目录里合并歌单的显示数量更新为去重后的真实数，
// 避免打开后目录仍显示"各平台 trackCount 之和"的未去重预估（如 510），
// 而歌单内实际只有 190 首的不一致。
function updateMergedPlaylistCatalogCount(snapshot) {
  if (!snapshot) return;
  var total = Math.max(0, Number(snapshot.total) || (snapshot.tracks || []).length || 0);
  if (!total) return;
  var record = mergedPlaylistRecordForId(MERGED_PLAYLIST_ID);
  if (!record || Number(record.trackCount) === total) return;
  record.trackCount = total;
  if (typeof playlistCatalogRevision !== 'undefined') playlistCatalogRevision += 1;
  if (typeof renderUserPlaylistsList === 'function') {
    try { renderUserPlaylistsList({ animate: false, preserveScroll: true }); } catch (e) { }
  }
}
function refreshMergedPlaylistCatalogFromSnapshot(snapshot, reason) {
  if (!snapshot || !(fx && fx.shelfMergeCollections) || !Array.isArray(userPlaylists)) return false;
  var total = Math.max(0, Number(snapshot.total) || (snapshot.tracks || []).length || 0);
  var changed = false;
  userPlaylists = userPlaylists.map(function (playlist) {
    if (!playlist || playlist.provider !== MERGED_PLAYLIST_PROVIDER || String(playlist.id || '') !== String(MERGED_PLAYLIST_ID)) return playlist;
    var next = buildMergedPlaylistRecord(playlist.sources || []);
    next.trackCount = total;
    if (Number(playlist.trackCount) !== total) changed = true;
    return next;
  });
  if (!changed) return false;
  playlistCatalogRevision += 1;
  if (typeof renderUserPlaylistsList === 'function') {
    try { renderUserPlaylistsList({ animate: false, preserveScroll: true }); } catch (e) { }
  }
  if (typeof scheduleShelfRebuild === 'function') scheduleShelfRebuild(reason || 'merged-playlist-cache-refresh', true);
  return true;
}
function mergedPlaylistSourcePage(source, offset, limit, signal) {
  var requestOptions = signal ? { signal: signal } : { timeoutMs: 16000 };
  return apiJson(playlistTracksEndpoint(source.provider, source.id, { offset: offset, limit: limit }), requestOptions);
}
async function prepareMergedPlaylistCache(record, options) {
  options = options || {};
  record = record || {};
  if (record.provider !== MERGED_PLAYLIST_PROVIDER) return null;
  var accountKey = options.accountKey || currentMergedPlaylistAccountKey();
  var forceSync = !!options.forceSync;
  var adapter = options.adapter || getMergedPlaylistCacheAdapter();
  // 非强制同步的 prepare 操作防重入：详情面板与播放入口并发打开合并歌单
  // 时共享同一次缓存读取/同步，避免触发两次全量拉取（表现为每次打开都像
  // 首次加载一样慢）。
  if (!forceSync && mergedPlaylistCacheRuntime.preparePromise) return mergedPlaylistCacheRuntime.preparePromise;
  var op = (async function () {
    var previous = mergedPlaylistCacheRuntime.accountKey === String(accountKey || 'anonymous')
      ? mergedPlaylistCacheRuntime.snapshot
      : null;
    if (!previous) previous = await loadMergedPlaylistCache(accountKey, adapter);
    if (previous && !forceSync && (record.sources || []).length) {
      // 缓存源集合与当前目录源不一致（新增/减少平台或歌单）时缓存已过时：
      // 直接复用旧快照会让详情显示旧缓存数、目录显示未去重预估（如 177 vs 190）；
      // 视为 miss 走下方同步/流式分支重新拉取，保证两者收敛到同一实际数。
      // sources 为空时不检查（避免空源覆盖已有缓存）。
      if (!mergedPlaylistSnapshotSourcesMatch(record.sources, previous)) {
        previous = null;
      }
    }
    if (previous && !forceSync) {
      mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
      mergedPlaylistCacheRuntime.snapshot = previous;
      updateMergedPlaylistCatalogCount(previous);
      console.log('[MergedPlaylistCache] cache-hit', accountKey, 'tracks=', (previous.tracks || []).length, 'partial=', !!previous.partial);
      // partial（部分平台上次拉取失败）时立即后台重试补全；否则等目录
      // 翻页完成后再后台同步，避免与目录加载抢带宽。
      var shouldBackgroundSync = options.preferCache !== false
        && (!!previous.partial || (typeof playlistCatalogHasPendingPages === 'function' && !playlistCatalogHasPendingPages()));
      // partial（部分平台上次拉取失败）立即后台补全；完整缓存则延迟到
      // 空闲窗口再后台同步，避免与用户打开歌单的缓存渲染并行抢带宽
      // （表现为第二次打开和第一次一样慢）。
      if (shouldBackgroundSync) {
        scheduleMergedPlaylistCacheSync('cached-playlist-background-sync', previous.partial ? 0 : 10000);
      }
      return { snapshot: previous, changed: false, partial: !!previous.partial, errors: previous.errors || [], cached: true, stale: true };
    }
    // stream 模式（首次打开流式加载）：缓存 miss 时不阻塞等全量同步，
    // 立即返回 streaming 标记，让调用方先用网络分页器逐页拉取、边加载边
    // 展示；全量同步转入后台执行并写缓存，保证下次打开直接命中（秒开）。
    if (options.stream && !forceSync && !previous) {
      console.log('[MergedPlaylistCache] cache-miss -> streaming (background sync)', accountKey, 'sources=', (record.sources || []).length);
      if (!mergedPlaylistCacheRuntime.promise) {
        mergedPlaylistCacheRuntime.promise = syncMergedPlaylistCache(record.sources || [], accountKey, {
          adapter: adapter,
          previousSnapshot: previous,
          pageSize: options.pageSize || 100,
          // 后台同步不绑定调用方（详情面板 controller）的 signal：用户关闭/切换
          // 歌单时 abort 只取消 UI 拉取，不影响缓存写入（否则缓存永远写不进，
          // 下次打开仍走全量同步）。网络请求走 mergedPlaylistSourcePage 的
          // timeoutMs 兜底。
          fetchPage: function (source, offset, limit) {
            return mergedPlaylistSourcePage(source, offset, limit, null);
          },
        }).then(function (result) {
          if (result && result.snapshot) {
            mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
            mergedPlaylistCacheRuntime.snapshot = result.snapshot;
            updateMergedPlaylistCatalogCount(result.snapshot);
          }
          return result;
        }).catch(function (error) {
          console.warn('[MergedPlaylistCache] background sync failed:', error && error.message || error);
          return null;
        }).finally(function () {
          mergedPlaylistCacheRuntime.promise = null;
        });
      }
      return { streaming: true, snapshot: null, changed: false, partial: false, errors: [], cached: false };
    }
    // 后台强制同步（scheduleMergedPlaylistCacheSync）进行中且本地无缓存时，
    // 复用该同步结果，避免再起一次全量拉取。
    if (!previous && !forceSync && mergedPlaylistCacheRuntime.promise) return mergedPlaylistCacheRuntime.promise;
    console.log('[MergedPlaylistCache] cache-miss -> full sync', accountKey, 'sources=', (record.sources || []).length, 'forceSync=', forceSync);
    var result = await syncMergedPlaylistCache(record.sources || [], accountKey, {
      adapter: adapter,
      previousSnapshot: previous,
      pageSize: options.pageSize || 100,
      fetchPage: function (source, offset, limit) {
        return mergedPlaylistSourcePage(source, offset, limit, options.signal);
      },
    });
    if (result && result.snapshot) {
      mergedPlaylistCacheRuntime.accountKey = String(accountKey || 'anonymous');
      mergedPlaylistCacheRuntime.snapshot = result.snapshot;
      updateMergedPlaylistCatalogCount(result.snapshot);
    }
    return result;
  })();
  if (!forceSync) {
    mergedPlaylistCacheRuntime.preparePromise = op;
    op.finally(function () {
      if (mergedPlaylistCacheRuntime.preparePromise === op) mergedPlaylistCacheRuntime.preparePromise = null;
    }).catch(function () { });
  }
  return op;
}
var mergedPlaylistSyncDelayTimer = 0;
function scheduleMergedPlaylistCacheSync(reason, delayMs, forceBuild) {
  if (!(fx && fx.shelfMergeCollections)) return Promise.resolve(null);
  var record = mergedPlaylistRecordForId(MERGED_PLAYLIST_ID);
  if (!record || !record.sources || !record.sources.length) return Promise.resolve(null);
  if (mergedPlaylistCacheRuntime.promise) {
    // 写操作脏标记（forceBuild）遇进行中的后台同步：等其完成后强制再重建一次，
    // 避免 in-flight 结果（写操作前的数据）重新持久化，覆盖合并歌单的新状态。
    if (forceBuild) {
      return mergedPlaylistCacheRuntime.promise.then(function () {
        return scheduleMergedPlaylistCacheSync(reason, 0, true);
      });
    }
    return mergedPlaylistCacheRuntime.promise;
  }
  // 用户的 prepare 正在进行（首次打开合并歌单全量同步中）：复用其结果，
  // 避免后台同步再并发触发一次全量拉取。
  if (mergedPlaylistCacheRuntime.preparePromise) return mergedPlaylistCacheRuntime.preparePromise;
  // 启动/目录刷新触发的后台同步仅在已有缓存时执行（刷新签名判断）。
  // 无缓存（首次使用）时不自动全量拉取所有源歌单曲目，等用户真正打开
  // 合并歌单时再同步——避免应用启动时叠加全量网络拉取导致"歌单加载"
  // 长时间无反馈，也避免后台同步与应用关闭交错导致缓存未保存完。
  // forceBuild（收藏/喜欢/移除等写操作触发的脏标记）时即使缓存刚被
  // invalidate（snapshot 置空）也必须重建，否则缓存删除后无人重建：
  // 目录 trackCount 停留在旧值、依赖缓存路径读不到最新歌曲。
  if (!mergedPlaylistCacheRuntime.snapshot && !forceBuild) return Promise.resolve(null);
  // delayMs > 0 时延迟执行：合并窗口内重复调度只保留最后一次，
  // 避免用户连续打开/切换歌单时叠加多次后台同步。
  if (delayMs > 0) {
    if (mergedPlaylistSyncDelayTimer) clearTimeout(mergedPlaylistSyncDelayTimer);
    return new Promise(function (resolve) {
      mergedPlaylistSyncDelayTimer = setTimeout(function () {
        mergedPlaylistSyncDelayTimer = 0;
        resolve(scheduleMergedPlaylistCacheSync(reason, 0, forceBuild));
      }, delayMs);
    });
  }
  mergedPlaylistCacheRuntime.promise = prepareMergedPlaylistCache(record, { reason: reason || 'catalog-refresh', forceSync: true }).catch(function (error) {
    console.warn('[MergedPlaylistCache]', reason || '', error);
    return { snapshot: mergedPlaylistCacheRuntime.snapshot, changed: false, partial: true, errors: [{ error: error && error.message || String(error) }] };
  }).finally(function () {
    mergedPlaylistCacheRuntime.promise = null;
  });
  return mergedPlaylistCacheRuntime.promise;
}
// 收藏/喜欢（红心）等改变源歌单内容的操作成功后调用：
// 先使合并歌单缓存失效（内存 + IndexedDB），再后台重同步，
// 保证下次加载合并歌单时能拿到包含新收藏歌曲的最新内容。
async function markMergedPlaylistDirty(reason) {
  if (!(fx && fx.shelfMergeCollections) || typeof invalidateMergedPlaylistCache !== 'function') return Promise.resolve(null);
  var accountKey = currentMergedPlaylistAccountKey();
  try {
    await invalidateMergedPlaylistCache(accountKey);
  } catch (e) {
    console.warn('[MergedPlaylistCache] invalidate failed:', e);
  }
  // forceBuild：缓存刚被 invalidate（snapshot 置空），必须重建缓存，
  // 否则 scheduleMergedPlaylistCacheSync 会因无缓存跳过后台重同步，
  // 导致合并歌单目录数量与内容停留在旧值。
  reason = reason || 'like-toggle';
  var result = await scheduleMergedPlaylistCacheSync(reason, 0, true);
  refreshMergedPlaylistCatalogFromSnapshot(result && result.snapshot, reason);
  return result;
}
function createMergedPlaylistPagerForRecord(record, signal) {
  record = record || {};
  return createMergedPlaylistPager(record.sources || [], function (source, offset, limit) {
    return mergedPlaylistSourcePage(source, offset, limit, signal);
  });
}
function fetchMergedPlaylistPage(pager, limit) {
  if (!pager || typeof pager.next !== 'function') return Promise.resolve({ tracks: [], total: 0, nextOffset: 0, hasMore: false, partial: true, errors: [{ error: 'MERGED_PLAYLIST_PAGER_MISSING' }] });
  return pager.next(limit);
}
// 合并歌单流式自动拉取的页数上限：防止异常分页器（持续 hasMore 且 nextOffset
// 递增）导致 120ms/页无限拉取。200 页 × 每页 48~160 首，远大于正常歌单规模。
var MERGED_PLAYLIST_AUTO_PAGE_LIMIT = 200;
function cancelPlaylistQueueHydration(reason) {
  var previous = queueHydrationState;
  if (previous && previous.timer) clearTimeout(previous.timer);
  if (previous) {
    previous.token += 1;
    previous.active = false;
    previous.loading = false;
    previous.promise = null;
    previous.timer = 0;
    previous.pausedForBuffer = false;
  }
  return reason || '';
}
function playlistQueueHydrationValid(state, token) {
  return !!(state && queueHydrationState === state && state.token === token && state.queueRef === playQueue);
}
function schedulePlaylistQueueHydration(delay, reason) {
  var state = queueHydrationState;
  if (!state || !state.active || state.error || state.queueRef !== playQueue) return false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(function () {
    state.timer = 0;
    hydratePlaylistQueueNextPage(reason || 'background');
  }, Math.max(0, Number(delay) || 0));
  return true;
}
async function hydratePlaylistQueueNextPage(reason) {
  var state = queueHydrationState;
  if (!state || !state.active || state.error || state.queueRef !== playQueue) return false;
  if (state.loading && state.promise) return state.promise;
  var token = state.token;
  var source = { provider: state.provider, id: state.sourceId, requestId: state.playlistId };
  var offset = Math.max(0, Number(state.nextOffset) || playQueue.length);
  var limit = playlistQueuePageSize(state.provider, false);
  state.loading = true;
  state.pausedForBuffer = false;
  var pageRequest = state.provider === MERGED_PLAYLIST_PROVIDER
    ? fetchMergedPlaylistPage(state.mergedPager, limit)
    : apiJson(playlistQueuePageUrl(source, offset, limit), { timeoutMs: 16000 });
  state.promise = pageRequest.then(function (r) {
    if (!playlistQueueHydrationValid(state, token)) return false;
    var rawTracks = r && r.tracks || [];
    if (r && r.error && !rawTracks.length) throw new Error(r.message || r.error);
    var pageTracks = rawTracks.map(cloneSong);
    if (state.liked) markSongsLiked(pageTracks, true);
    if (playMode === 'shuffle' && pageTracks.length > 1) shuffleArrayInPlace(pageTracks);
    if (pageTracks.length) Array.prototype.push.apply(playQueue, pageTracks);
    state.loaded = playQueue.length;
    // 合并歌单：总数以去重后的实际加载数为准，忽略未去重预估 total。
    state.total = state.provider === MERGED_PLAYLIST_PROVIDER
      ? Math.max(state.total || 0, state.loaded)
      : Math.max(state.total || 0, Number(r && (r.total || (r.playlist && r.playlist.trackCount))) || 0, state.loaded);
    state.nextOffset = state.provider === MERGED_PLAYLIST_PROVIDER
      ? Math.max(Number(r && r.nextOffset) || 0, offset + rawTracks.length)
      : Math.max(Number(r && r.nextOffset) || 0, offset + rawTracks.length);
    state.hasMore = !!(r && r.hasMore);
    state.partial = state.partial || !!(r && r.partial);
    if (!rawTracks.length || state.nextOffset <= offset) state.hasMore = false;
    state.active = state.provider === MERGED_PLAYLIST_PROVIDER
      ? state.hasMore
      : (state.hasMore || (!!state.total && state.nextOffset < state.total));
    state.pausedForBuffer = state.active;
    safeRenderQueuePanel('playlist-queue-hydrate', { animate: false, scrollCurrent: false });
    if (!state.active) {
      state.loading = false;
      state.promise = null;
      state.pausedForBuffer = false;
      safeRenderQueuePanel('playlist-queue-hydrate-complete', { animate: false, scrollCurrent: false });
    } else if (state.provider === MERGED_PLAYLIST_PROVIDER && !state.error && state.token === token) {
      // 合并歌单流式加载：自动继续拉取直到全部（不依赖播放/滚动触发）。
      // 页数上限兜底，防止异常分页器（持续 hasMore 且 nextOffset 递增）死循环。
      if (state.mergedAutoPages >= MERGED_PLAYLIST_AUTO_PAGE_LIMIT) state.active = false;
      else {
        state.mergedAutoPages += 1;
        schedulePlaylistQueueHydration(120, 'merged-auto-hydrate');
      }
    }
    return pageTracks.length > 0;
  }).catch(function (e) {
    if (!playlistQueueHydrationValid(state, token)) return false;
    console.warn('[PlaylistQueueHydration]', state.playlistId, reason || '', e);
    state.error = e && e.message || 'PLAYLIST_QUEUE_PAGE_FAILED';
    state.active = false;
    state.pausedForBuffer = false;
    safeRenderQueuePanel('playlist-queue-hydrate-error', { animate: false, scrollCurrent: false });
    return false;
  }).finally(function () {
    if (!playlistQueueHydrationValid(state, token)) return;
    state.loading = false;
    state.promise = null;
  });
  safeRenderQueuePanel('playlist-queue-hydrate-start', { animate: false, scrollCurrent: false });
  return state.promise;
}
function retryPlaylistQueueHydration() {
  var state = queueHydrationState;
  if (!state || state.queueRef !== playQueue) return false;
  state.error = '';
  state.active = state.provider === MERGED_PLAYLIST_PROVIDER
    ? state.hasMore
    : (state.hasMore || !state.total || state.nextOffset < state.total);
  if (!state.active) return false;
  state.pausedForBuffer = false;
  hydratePlaylistQueueNextPage('retry');
  return true;
}
function ensurePlaylistQueueHydratedAhead(index) {
  var state = queueHydrationState;
  if (!state || state.queueRef !== playQueue || !state.active || state.error) return false;
  if (playQueue.length - Math.max(0, Number(index) || 0) <= PLAYLIST_QUEUE_PLAYBACK_AHEAD_THRESHOLD) {
    state.pausedForBuffer = false;
    return schedulePlaylistQueueHydration(0, 'playback-ahead');
  }
  return false;
}
function requestPlaylistQueueHydrationForBrowse() {
  var state = queueHydrationState;
  if (!state || state.queueRef !== playQueue || !state.active || state.loading || state.error) return false;
  state.pausedForBuffer = false;
  return schedulePlaylistQueueHydration(0, 'queue-browse-tail');
}
async function loadPlaylistIntoQueueById(id, autoplay, title, opts) {
  if (!id) return false;
  opts = opts || {};
  if (!opts.preserveHomeState) {
    homeForcedOpen = false;
    homeSuppressed = false;
    updateEmptyHomeVisibility();
  }
  showLoading();
  cancelPlaylistQueueHydration('new-playlist');
  var source = playlistQueueSource(id);
  var token = (queueHydrationState && queueHydrationState.token || 0) + 1;
  var mergedPager = opts.mergedPager || null;
  var r = null;
  var seedTracks = Array.isArray(opts.seedTracks) && opts.seedTracks.length ? opts.seedTracks.map(cloneSong) : [];
  try {
    if (!seedTracks.length) {
      if (source.provider === MERGED_PLAYLIST_PROVIDER && !mergedPager) {
        var cacheRecord = mergedPlaylistRecordForId(source.id);
        var cacheResult = await prepareMergedPlaylistCache(cacheRecord, { stream: true });
        mergedPager = cacheResult && cacheResult.snapshot
          ? createMergedPlaylistCachedPager(cacheResult.snapshot)
          : createMergedPlaylistPagerForRecord(cacheRecord);
      }
      // 合并歌单流式加载：首次只拉一页立即播放，其余由 hydration 自动连续拉取。
      r = source.provider === MERGED_PLAYLIST_PROVIDER
        ? await fetchMergedPlaylistPage(mergedPager, playlistQueuePageSize(source.provider, true))
        : await apiJson(playlistQueuePageUrl(source, 0, playlistQueuePageSize(source.provider, true)), { timeoutMs: 16000 });
      seedTracks = (r && r.tracks || []).map(cloneSong);
    } else {
      r = {
        playlist: opts.playlist || null,
        tracks: seedTracks,
        total: opts.total,
        nextOffset: opts.nextOffset,
        hasMore: opts.hasMore
      };
    }
  } catch (e) {
    console.warn('[PlaylistLoadFirstPage]', id, e);
    showToast('歌单首批加载失败');
    hideLoading();
    return false;
  }
  try {
    if (!seedTracks.length) {
      showToast(r && (r.message || r.error) || '歌单为空');
      return false;
    }
    playQueue = seedTracks;
    var catalogPlaylist = userPlaylists.find(function (pl) {
      return normalizePlaylistProvider(pl && pl.provider) === source.provider && String(pl && pl.id || '') === String(source.id || '');
    });
    // 合并歌单：总数以去重后的实际队列长度为准。各平台 trackCount 之和（未去重
    // 预估，如 273）与网络回退分页器的 total 都不能作为总数残留。
    var total = source.provider === MERGED_PLAYLIST_PROVIDER
      ? playQueue.length
      : Math.max(playQueue.length, Number(r && (r.total || (r.playlist && r.playlist.trackCount))) || Number(opts.total) || Number(catalogPlaylist && catalogPlaylist.trackCount) || 0);
    var nextOffset = Math.max(Number(r && r.nextOffset) || Number(opts.nextOffset) || playQueue.length, playQueue.length);
    var hasMore = opts.hasMore != null ? !!opts.hasMore : !!(r && r.hasMore);
    if (source.provider !== MERGED_PLAYLIST_PROVIDER && total > nextOffset) hasMore = true;
    var liked = isLikedPlaylistContext(id, title, r && r.playlist);
    if (liked) markSongsLiked(playQueue, true);
    else if (source.provider === 'netease') syncLikeStatusForSongs(playQueue);
    queueHydrationState = {
      token: token,
      active: hasMore,
      loading: false,
      provider: source.provider,
      playlistId: source.requestId,
      sourceId: source.id,
      title: title || (r && r.playlist && r.playlist.name) || '',
      total: total,
      nextOffset: nextOffset,
      hasMore: hasMore,
      loaded: playQueue.length,
      error: '',
      promise: null,
      timer: 0,
      queueRef: playQueue,
      liked: liked,
      warmPagesRemaining: hasMore ? 1 : 0,
      pausedForBuffer: false,
      mergedPager: mergedPager,
      mergedAutoPages: 0,
      partial: !!(r && r.partial) || !!opts.partial
    };
    currentIdx = Math.max(0, Math.min(playQueue.length - 1, Number(opts.startIndex) || 0));
    safeRenderQueuePanel('playlist-load-first-page', { animate: true, scrollCurrent: true, deferWhenHidden: false });
    safeSwitchPlaylistTab('queue', 'playlist-load-first-page');
    safeShelfRebuild('playlist-load-first-page', true);
    forcePlaybackControlsInteractive();
    hideLoading();
    if (autoplay) {
      try {
        await playQueueAt(currentIdx, { preserveHomeState: !!opts.preserveHomeState });
      } catch (playErr) {
        console.warn('[PlaylistAutoplay]', id, playErr);
        showToast('歌单已载入，播放启动失败');
      }
    }
    forcePlaybackControlsInteractive();
    if (queueHydrationState.active) {
      showToast('已开始播放，后续歌曲会按需流式加入队列');
      if (source.provider === MERGED_PLAYLIST_PROVIDER) {
        // 合并歌单：hydration 每页完成后会自动继续调度，直到全部加载完
        schedulePlaylistQueueHydration(120, 'initial-merged-page');
      } else if (queueHydrationState.warmPagesRemaining > 0) {
        queueHydrationState.warmPagesRemaining -= 1;
        schedulePlaylistQueueHydration(180, 'initial-warm-page');
      }
    } else {
      showToast('载入: ' + (title || ('歌单 ' + id)));
    }
    return true;
  } catch (e) {
    console.warn('[PlaylistLoadState]', id, e);
    forcePlaybackControlsInteractive();
    showToast('歌单已载入，界面刷新失败');
    return false;
  } finally {
    hideLoading();
  }
}

// 进度条
