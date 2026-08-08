var playlistPanelDetailState = { key: '', loading: false, loadingMore: false, playlist: null, tracks: [], token: 0, total: 0, nextOffset: 0, hasMore: false, scrollTop: 0, controller: null, warmTimer: 0, mergedPager: null, mergedAutoPages: 0, partial: false, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
// 合并歌单流式自动拉取的页数上限：防止异常分页器（持续 hasMore 且 nextOffset
// 递增）导致 120ms/页无限拉取。200 页 × 每页 48 首，远大于正常歌单规模。
var PLAYLIST_DETAIL_MERGED_AUTO_PAGE_LIMIT = 200;
function queueVirtualSpacerHtml(height) {
  height = Math.max(0, Math.round(Number(height) || 0));
  return height ? '<div class="queue-virtual-spacer" aria-hidden="true" style="height:' + height + 'px"></div>' : '';
}
function queuePanelVirtualWindow(list, scroller, total, selfScroll, forceIndex) {
  total = Math.max(0, Number(total) || 0);
  if (!total) return { start: 0, end: 0, top: 0, bottom: 0 };
  var rowStep = QUEUE_VIRTUAL_ROW_STEP;
  var viewport = Math.max(rowStep * 4, Number(scroller && scroller.clientHeight) || rowStep * 9);
  var visibleRows = Math.max(4, Math.ceil(viewport / rowStep));
  var start = 0;
  if (forceIndex != null && forceIndex >= 0 && forceIndex < total) {
    start = Math.max(0, Math.floor(forceIndex - visibleRows * 0.42) - QUEUE_VIRTUAL_OVERSCAN);
  } else if (selfScroll) {
    start = Math.max(0, Math.floor((Number(scroller && scroller.scrollTop) || 0) / rowStep) - QUEUE_VIRTUAL_OVERSCAN);
  } else if (list && scroller && list.getBoundingClientRect && scroller.getBoundingClientRect) {
    var listRect = list.getBoundingClientRect();
    var scrollerRect = scroller.getBoundingClientRect();
    var visibleTop = Math.max(0, scrollerRect.top - listRect.top);
    start = Math.max(0, Math.floor(visibleTop / rowStep) - QUEUE_VIRTUAL_OVERSCAN);
  }
  var maxRows = visibleRows + QUEUE_VIRTUAL_OVERSCAN * 2;
  var end = Math.min(total, start + maxRows);
  start = Math.max(0, Math.min(start, Math.max(0, total - maxRows)));
  end = Math.min(total, Math.max(end, start + maxRows));
  return { start: start, end: end, top: start * rowStep, bottom: Math.max(0, total - end) * rowStep };
}
function scheduleQueuePanelVirtualRender() {
  if (queuePanelVirtualState.raf) return;
  queuePanelVirtualState.raf = requestAnimationFrame(function () {
    queuePanelVirtualState.raf = 0;
    if (miniQueueOpen) renderMiniQueuePanel({ animate: false, scrollCurrent: false });
    if (queueViewTab === 'queue' && isPlaylistPanelVisibleForRender()) {
      renderQueuePanel({ animate: false, scrollCurrent: false });
    }
  });
}
function maybeRequestPlaylistQueuePageFromScroller(scroller) {
  if (!scroller || typeof requestPlaylistQueueHydrationForBrowse !== 'function') return false;
  if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - QUEUE_VIRTUAL_ROW_STEP * 6) return false;
  return requestPlaylistQueueHydrationForBrowse();
}
function queuePanelItemKey(song, fallback) {
  try {
    if (typeof queueItemKey === 'function') return queueItemKey(song) || fallback;
  } catch (e) { }
  return song && (song.id || song.mid || song.localKey || song.name) || fallback;
}
function queuePanelListKey() {
  var total = playQueue && playQueue.length || 0;
  if (!total) return '0';
  return [
    total,
    queuePanelItemKey(playQueue[0], 'first'),
    queuePanelItemKey(playQueue[Math.max(0, total - 1)], 'last')
  ].join('|');
}
function resetQueuePanelRenderLimit() {
  queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
  queuePanelRenderKey = queuePanelListKey();
}
function queuePanelVisibleLimit(total) {
  total = Math.max(0, Number(total) || 0);
  if (!total) {
    queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
    queuePanelRenderKey = '0';
    return 0;
  }
  var key = queuePanelListKey();
  if (key !== queuePanelRenderKey) {
    queuePanelRenderKey = key;
    queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
  }
  var base = Math.max(QUEUE_PANEL_BATCH_SIZE, queuePanelRenderLimit || QUEUE_PANEL_BATCH_SIZE);
  if (currentIdx >= 0 && currentIdx < total) {
    base = Math.max(base, Math.ceil((currentIdx + 1) / QUEUE_PANEL_BATCH_SIZE) * QUEUE_PANEL_BATCH_SIZE);
  }
  queuePanelRenderLimit = Math.min(total, base);
  return queuePanelRenderLimit;
}
function growQueuePanelRenderLimit(amount) {
  if (!playQueue.length) return false;
  var total = playQueue.length;
  var current = queuePanelVisibleLimit(total);
  var next = Math.min(total, current + (amount || QUEUE_PANEL_BATCH_SIZE));
  if (next <= current) return false;
  var panel = document.getElementById('playlist-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  var miniList = document.getElementById('mini-queue-list');
  var keepMiniTop = miniList ? miniList.scrollTop : 0;
  queuePanelRenderLimit = next;
  renderQueuePanel({ animate: true, scrollCurrent: false });
  if (panel) panel.scrollTop = keepTop;
  if (miniList) {
    miniList = document.getElementById('mini-queue-list');
    if (miniList) miniList.scrollTop = keepMiniTop;
  }
  return true;
}
function maybeGrowQueuePanelRenderLimit() {
  var panel = document.getElementById('playlist-panel');
  if (!panel || queueViewTab !== 'queue' || !playQueue.length) return;
  if (queuePanelVisibleLimit(playQueue.length) >= playQueue.length) return;
  if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 220) growQueuePanelRenderLimit();
}
function bindMiniQueueLazyRender() {
  var list = document.getElementById('mini-queue-list');
  if (!list || miniQueueLazyBound) return;
  miniQueueLazyBound = true;
  list.addEventListener('scroll', function () {
    if (!miniQueueOpen) return;
    scheduleQueuePanelVirtualRender();
    maybeRequestPlaylistQueuePageFromScroller(list);
  }, { passive: true });
}
function normalizePlaylistProvider(provider) {
  if (provider === 'qq' || provider === 'kugou' || provider === 'qishui' || provider === 'spotify' || provider === MERGED_PLAYLIST_PROVIDER) return provider;
  return 'netease';
}
function playlistProviderLabel(provider) {
  provider = normalizePlaylistProvider(provider);
  return provider === MERGED_PLAYLIST_PROVIDER ? 'ALL' : (provider === 'qq' ? 'QQ' : (provider === 'kugou' ? 'KG' : (provider === 'qishui' ? 'QS' : (provider === 'spotify' ? 'SP' : 'NE'))));
}
function playlistProviderName(provider) {
  provider = normalizePlaylistProvider(provider);
  if (provider === MERGED_PLAYLIST_PROVIDER) return '跨平台';
  if (provider === 'spotify') return 'Spotify';
  return provider === 'qq' ? 'QQ 音乐' : (provider === 'kugou' ? '酷狗音乐' : (provider === 'qishui' ? '汽水音乐' : '网易云音乐'));
}
function playlistPanelKey(provider, id) {
  provider = normalizePlaylistProvider(provider);
  return provider + ':' + String(id || '');
}
function playlistPanelProviderId(provider, id) {
  provider = normalizePlaylistProvider(provider);
  if (provider === MERGED_PLAYLIST_PROVIDER) return 'merged:' + id;
  if (provider === 'qq') return 'qq:' + id;
  if (provider === 'kugou') return 'kugou:' + id;
  if (provider === 'qishui') return 'qishui:' + id;
  if (provider === 'spotify') return 'spotify:' + id;
  return id;
}
function closePlaylistPanelDetail(reason) {
  cancelPlaylistPanelDetailRequest();
  playlistPanelDetailState.token += 1;
  playlistPanelDetailState.key = '';
  playlistPanelDetailState.loading = false;
  playlistPanelDetailState.loadingMore = false;
  playlistPanelDetailState.playlist = null;
  playlistPanelDetailState.tracks = [];
  playlistPanelDetailState.total = 0;
  playlistPanelDetailState.nextOffset = 0;
  playlistPanelDetailState.hasMore = false;
  playlistPanelDetailState.mergedPager = null;
  playlistPanelDetailState.partial = false;
  playlistPanelDetailState.error = '';
  playlistPanelDetailState.message = reason || '';
  playlistPanelDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
  if (typeof renderPlaylistPanelDetailState === 'function') renderPlaylistPanelDetailState();
}
function playlistCardPriority(pl) {
  if (!pl) return 10;
  if (pl.virtual || String(pl.id || '') === 'spotify-liked' || Number(pl.specialType || 0) === 5) return 0;
  return 1;
}
function prioritizePlaylistGroupItems(items) {
  return (items || []).map(function (pl, idx) {
    return { pl: pl, idx: idx, priority: playlistCardPriority(pl) };
  }).sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.idx - b.idx;
  }).map(function (entry) { return entry.pl; });
}
function playlistPanelNoticeHtml(text, isError) {
  text = String(text || '').trim();
  if (!text) text = '歌单暂无可播放歌曲';
  return '<div style="text-align:center;padding:14px 10px;color:' + (isError ? 'rgba(255,180,160,.82)' : 'rgba(255,255,255,.30)') + ';font-size:11.5px;line-height:1.55">' + escHtml(text) + '</div>';
}
// 当前歌单详情是否为"我的喜欢/喜欢的音乐"歌单（网易云 specialType=5 或标题匹配）
function isDetailPlaylistLikedContext() {
  var st = playlistPanelDetailState;
  var pl = st && st.playlist;
  if (!pl) return false;
  if (Number(pl.specialType || 0) === 5) return true;
  var parts = String(st.key || '').split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  return isLikedPlaylistContext(pid, pl.name, pl);
}
// 歌单详情行右侧操作按钮：红心（我的喜欢歌单中即"移除喜欢"）+ 从歌单移除
function detailPlaylistRowActionsHtml(song, index) {
  var st = playlistPanelDetailState;
  if (!song || !st || !st.key) return '';
  var parts = st.key.split(':');
  var detailProvider = normalizePlaylistProvider(parts[0]);
  var isMerged = detailProvider === MERGED_PLAYLIST_PROVIDER;
  // merged 详情按歌曲来源平台取 adapter（红心/移除作用于来源平台歌单）
  var provider = isMerged ? songAccountProvider(song) : detailProvider;
  var adapter = songAccountAdapter(provider);
  if (!adapter) return '';
  var html = '';
  if (adapter.like && adapter.likeUrl) {
    var liked = isSongLiked(song);
    var likedContext = isDetailPlaylistLikedContext();
    html += '<button class="pl-detail-act' + (liked ? ' liked' : '') + '" type="button" title="' + (likedContext && liked ? '移除喜欢' : (liked ? '取消红心' : '红心喜欢')) + '" onclick="event.stopPropagation();toggleLikeDetailPlaylistTrack(' + index + ')">' + heartIconSvg() + '</button>';
  }
  var canRemove = false;
  if (isMerged) {
    // 合并歌单：本地收藏歌曲（merged:local-collect）走本地移除；其余需
    // 能定位来源歌单且来源平台支持移除
    var mergedSrc = resolveMergedTrackSource(song);
    canRemove = !!mergedSrc && (mergedSrc.provider === MERGED_PLAYLIST_PROVIDER ? mergedSrc.id === MERGED_LOCAL_COLLECT_SOURCE_ID : !!adapter.playlistRemoveUrl);
  } else {
    canRemove = !!adapter.playlistRemoveUrl;
  }
  if (canRemove) {
    html += '<button class="pl-detail-act pl-detail-remove" type="button" title="从歌单移除" onclick="event.stopPropagation();removeDetailPlaylistTrack(' + index + ')">×</button>';
  }
  return html;
}
// 定位 merged 歌曲的来源平台歌单（provider + 歌单 id）
function resolveMergedTrackSource(song) {
  if (!song) return null;
  if (song.sourcePlaylistId) {
    // 以组装时记录的来源平台为准（与 song.provider 可能不一致）
    var provider = song.sourcePlaylistProvider || song.provider || songAccountProvider(song);
    return { provider: provider, id: String(song.sourcePlaylistId) };
  }
  // 兜底：旧缓存快照中的歌曲可能没有来源字段，从 sources.tracks 反查
  var snapshot = typeof mergedPlaylistCacheRuntime !== 'undefined' && mergedPlaylistCacheRuntime && mergedPlaylistCacheRuntime.snapshot;
  var sources = snapshot && Array.isArray(snapshot.sources) ? snapshot.sources : [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i] || {};
    if (String(source.provider || '') !== songAccountProvider(song)) continue;
    var hit = (source.tracks || []).some(function (track) {
      return !!track && queuePanelItemKey(track) === queuePanelItemKey(song);
    });
    if (hit) return { provider: String(source.provider || ''), id: String(source.id || '') };
  }
  return null;
}
async function toggleLikeDetailPlaylistTrack(index) {
  var st = playlistPanelDetailState;
  var song = st.tracks && st.tracks[index];
  if (!song) return;
  var wasLiked = isSongLiked(song);
  // 喜欢类上下文（"我的喜欢"歌单，或 merged 中来自喜欢类来源歌单的歌曲）
  // 在歌单详情中未同步 likedSongMap：预置为已喜欢，避免 toggle 反向变成重新喜欢
  if (!wasLiked && detailTrackInLikedContext(song)) {
    var key = songAccountStateKey(song);
    if (key) { likedSongMap[key] = true; wasLiked = true; }
  }
  await toggleLikeSong(song);
  // 在"我的喜欢"歌单中取消红心 = 从该歌单移除，立即从详情列表消失
  if (isDetailPlaylistLikedContext() && wasLiked && !isSongLiked(song)) {
    removeTrackFromDetailList(index);
  }
}
// 歌曲是否处于"喜欢类"上下文（红心必为已喜欢，避免 toggle 反向）
function detailTrackInLikedContext(song) {
  var st = playlistPanelDetailState;
  if (!st || !song || !st.key) return false;
  var parts = String(st.key || '').split(':');
  var detailProvider = normalizePlaylistProvider(parts[0]);
  if (detailProvider !== MERGED_PLAYLIST_PROVIDER) return isDetailPlaylistLikedContext();
  var src = resolveMergedTrackSource(song);
  if (!src) return false;
  if (src.provider === 'spotify') return src.id === 'spotify-liked' || src.id === 'liked';
  var sourcePl = (userPlaylists || []).find(function (pl) {
    return normalizePlaylistProvider(pl && pl.provider) === src.provider && String(pl && pl.id || '') === src.id;
  });
  if (sourcePl) return Number(sourcePl.specialType || 0) === 5 || isLikedPlaylistContext(src.id, sourcePl.name, sourcePl);
  return /我喜欢|喜欢的音乐|liked/i.test(String(src.id || ''));
}
function removeTrackFromDetailList(index) {
  var st = playlistPanelDetailState;
  if (!st || !st.tracks || !st.tracks[index]) return false;
  st.tracks.splice(index, 1);
  st.total = Math.max(st.tracks.length, Math.max(0, (Number(st.total) || 0) - 1));
  if (st.playlist && typeof st.playlist.trackCount === 'number') {
    st.playlist.trackCount = Math.max(0, st.playlist.trackCount - 1);
  }
  renderPlaylistPanelDetailRows();
  return true;
}
// 歌曲移出来源歌单后，如果仍处于喜欢状态，继续调用统一取消喜欢流程。
// 返回 false 只表示红心取消失败，不影响来源歌单已经完成的移除。
async function unlikeSongAfterPlaylistRemove(song) {
  if (typeof isSongLiked !== 'function' || !isSongLiked(song)) return true;
  if (typeof toggleLikeSong !== 'function') {
    showToast('歌曲已移出歌单，但取消红心功能不可用');
    return false;
  }
  try { await toggleLikeSong(song); } catch (_) { }
  if (typeof isSongLiked === 'function' && isSongLiked(song)) {
    showToast('歌曲已移出歌单，但取消红心失败');
    return false;
  }
  return true;
}
// 从来源平台歌单移除歌曲（核心逻辑，可复用：歌单详情面板与 3D 歌单架内容框共用）
// source: { provider, id, merged, liked }；返回 true = 移除成功
async function removeSongFromSourcePlaylist(song, source) {
  if (!song || !source || !source.provider || !source.id) {
    showToast('无法定位该歌曲的来源歌单，暂不能移除');
    return false;
  }
  var provider = source.provider;
  var pid = String(source.id);
  // 合并歌单本地收藏（平台写不可用时加入的歌曲）没有平台歌单实体，
  // "从歌单移除" = 从本地收藏删除。
  if (provider === MERGED_PLAYLIST_PROVIDER && pid === MERGED_LOCAL_COLLECT_SOURCE_ID) {
    if (typeof mergedRemoveLocalCollectSong === 'function') mergedRemoveLocalCollectSong(song);
    var localKey = songAccountStateKey(song);
    if (localKey) likedSongMap[localKey] = false;
    updateLikeButtons(song);
    safeRenderQueuePanel('detail-remove-like', { scrollCurrent: miniQueueOpen });
    refreshSearchResultActionStates();
    if (typeof markMergedPlaylistDirty === 'function') markMergedPlaylistDirty('local-collect-remove').catch(function () { });
    showToast('已从合并歌单移除（本地收藏）');
    return true;
  }
  // 合并歌单中的 QQ 来源歌曲只维护本地排除记录，不调用 QQ 平台写接口。
  if (source.merged && provider === 'qq') {
    if (source.liked) {
      var qqLikeKey = songAccountStateKey(song);
      if (qqLikeKey) likedSongMap[qqLikeKey] = true;
    }
    if (typeof mergedAddLocalRemoval !== 'function' || !mergedAddLocalRemoval(song, source)) {
      showToast('QQ 合并歌单本地更新失败');
      return false;
    }
    var qqUnlikeOk = await unlikeSongAfterPlaylistRemove(song);
    if (typeof markMergedPlaylistDirty === 'function') {
      markMergedPlaylistDirty('qq-merged-local-remove').catch(function () { });
    }
    showToast(qqUnlikeOk ? '已从合并歌单移除（QQ 仅更新本地）' : '已从合并歌单移除，但取消红心失败');
    return true;
  }
  var adapter = songAccountAdapter(provider);
  if (!adapter || !adapter.playlistRemoveUrl) {
    showToast(playlistProviderName(provider) + '暂不支持从歌单移除歌曲');
    return false;
  }
  if (!ensureLoggedInForAction(provider)) return false;
  // Spotify 喜欢伪歌单（spotify-liked）没有真实歌单实体，"从歌单移除"= 取消红心。
  // 歌曲出现在 liked 源中即证明已被喜欢：预置 likedSongMap 后走 toggleLikeSong
  // 的 unlike 分支（勿直接 toggle——merged 视图未同步 likedSongMap 时会反向重新喜欢）。
  if (provider === 'spotify' && (pid === 'spotify-liked' || pid === 'liked')) {
    var spotifyKey = songAccountStateKey(song);
    if (!spotifyKey) { showToast('缺少 Spotify 歌曲标识'); return false; }
    likedSongMap[spotifyKey] = true;
    await toggleLikeSong(song);
    if (!isSongLiked(song)) {
      showToast('已从 Spotify 喜欢移除');
      // toggleLikeSong 内部已失效合并歌单缓存并重同步，无需重复处理
      return true;
    }
    return false;
  }
  try {
    var r = await apiJson(adapter.playlistRemoveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: pid, song: song, id: songAccountId(song, provider) })
    });
    if (r && (r.error || r.success === false)) throw new Error(r.error || r.message || 'PLAYLIST_REMOVE_FAILED');
    // 喜欢类来源的歌曲在载入详情时可能尚未写入 likedSongMap，先恢复为已喜欢，
    // 再由统一取消喜欢流程调用对应平台接口；普通歌单中已红心歌曲同样会走这里。
    if (source.liked) {
      var key = songAccountStateKey(song);
      if (key) likedSongMap[key] = true;
    }
    if (source.likedPlaylist) {
      var key = songAccountStateKey(song);
      if (key) likedSongMap[key] = false;
      unlikeOk = true;
    } else {
      var unlikeOk = await unlikeSongAfterPlaylistRemove(song);
    }
    showToast(unlikeOk
      ? (source.merged ? '已从来源歌单移除' : '已从歌单移除')
      : (source.merged ? '已从来源歌单移除，但取消红心失败' : '已从歌单移除，但取消红心失败'));
    updateLikeButtons(song);
    safeRenderQueuePanel('detail-remove-like', { scrollCurrent: miniQueueOpen });
    refreshSearchResultActionStates();
    // 移除改变源歌单内容：失效合并歌单缓存并后台重同步（"同时移除合并歌单"）
    if (typeof markMergedPlaylistDirty === 'function') {
      markMergedPlaylistDirty('playlist-remove-song').catch(function () { });
    }
    return true;
  } catch (err) {
    var errorText = String(err && err.message || '');
    if (/KUGOU_PLAYLIST_REMOVE_UNSUPPORTED/i.test(errorText)) {
      showToast('酷狗不允许从该歌单移除歌曲，请确认这是自己创建的歌单');
      return false;
    }
    if (/SCOPE|PERMISSION/i.test(errorText)) showToast('当前授权缺少歌单写入权限，请重新授权');
    else if (/LOGIN_REQUIRED|AUTH_REQUIRED/i.test(errorText)) showToast(adapter.label + '登录状态已失效，请重新登录');
    else if (/NOT_IN_LIST|KUGOU_SONG_NOT_IN_LIST/i.test(errorText)) showToast('歌曲不在该歌单中，或位于歌单较后位置暂无法定位');
    else showToast(errorText ? ('从歌单移除失败: ' + errorText) : '从歌单移除失败');
    return false;
  }
}
async function removeDetailPlaylistTrack(index) {
  var st = playlistPanelDetailState;
  var song = st.tracks && st.tracks[index];
  if (!song || !st.key) return;
  var parts = st.key.split(':');
  var detailProvider = normalizePlaylistProvider(parts[0]);
  var isMerged = detailProvider === MERGED_PLAYLIST_PROVIDER;
  var source;
  if (isMerged) {
    // 合并歌单：定位歌曲的来源平台歌单，移除同步到该平台歌单
    var resolved = resolveMergedTrackSource(song);
    if (!resolved || !resolved.id) {
      showToast('无法定位该歌曲的来源歌单，暂不能移除');
      return;
    }
    source = { provider: resolved.provider, id: resolved.id, merged: true, liked: detailTrackInLikedContext(song), likedPlaylist: detailTrackInLikedContext(song) };
  } else {
    source = { provider: detailProvider, id: parts.slice(1).join(':'), merged: false, liked: isDetailPlaylistLikedContext(), likedPlaylist: isDetailPlaylistLikedContext() };
  }
  var ok = await removeSongFromSourcePlaylist(song, source);
  if (ok) removeTrackFromDetailList(index);
}
// 删除歌单成功后同步移除本地目录中的歌单记录（含各平台原始数组）
function removePlaylistFromLocalCatalog(provider, id) {
  var rows = playlistCatalogProviderArray(provider);
  var next = (rows || []).filter(function (pl) { return String(pl && pl.id || '') !== String(id); });
  if (next.length !== (rows || []).length) setPlaylistCatalogProviderArray(provider, next);
  userPlaylists = (userPlaylists || []).filter(function (pl) {
    return !(normalizePlaylistProvider(pl && pl.provider) === provider && String(pl && pl.id || '') === String(id));
  });
  playlistCatalogRevision += 1;
}
// 删除歌单（核心逻辑，可复用：歌单详情面板与 3D 歌单架卡片共用）
async function deletePlaylistByKey(provider, id, name) {
  provider = normalizePlaylistProvider(provider);
  var adapter = songAccountAdapter(provider);
  if (!adapter || !adapter.playlistDeleteUrl) {
    showToast(playlistProviderName(provider) + '暂不支持删除歌单');
    return false;
  }
  if (!ensureLoggedInForAction(provider)) return false;
  if (!window.confirm('确定删除歌单「' + (name || '未命名歌单') + '」吗？删除后不可恢复。')) return false;
  try {
    var r = await apiJson(adapter.playlistDeleteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, pid: id })
    });
    if (r && (r.error || r.success === false)) throw new Error(r.error || r.message || 'PLAYLIST_DELETE_FAILED');
    showToast('歌单已删除');
    removePlaylistFromLocalCatalog(provider, id);
    if (typeof markMergedPlaylistDirty === 'function') {
      markMergedPlaylistDirty('playlist-delete').catch(function () { });
    }
    if (typeof refreshUserPlaylists === 'function') refreshUserPlaylists(true).catch(function () { });
    if (typeof scheduleShelfRebuild === 'function') scheduleShelfRebuild('playlist-delete', true);
    return true;
  } catch (err) {
    var errorText = String(err && err.message || '');
    if (/SCOPE|PERMISSION/i.test(errorText)) showToast('当前授权缺少歌单管理权限，请重新授权');
    else if (/LOGIN_REQUIRED|AUTH_REQUIRED/i.test(errorText)) showToast(adapter.label + '登录状态已失效，请重新登录');
    else showToast(errorText ? ('删除歌单失败: ' + errorText) : '删除歌单失败');
    return false;
  }
}
async function deleteDetailPlaylist() {
  var st = playlistPanelDetailState;
  if (!st || !st.key || !st.playlist) return;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var id = parts.slice(1).join(':');
  var ok = await deletePlaylistByKey(provider, id, st.playlist.name);
  if (ok) {
    // 关闭详情并重渲染（目录已由 deletePlaylistByKey 移除并刷新）
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    playlistPanelDetailState.total = 0;
    playlistPanelDetailState.hasMore = false;
    renderPlaylistPanelDetailState();
  }
}
function playlistPanelDetailRowsHtml(options) {
  options = options || {};
  var st = playlistPanelDetailState;
  var tracks = st.tracks || [];
  if (st.loading && !tracks.length) {
    return '<div class="pl-detail-row pl-detail-loading-row"><span class="queue-hydration-spinner spinning"></span><div style="flex:1;min-width:0"><div class="pl-detail-row-title">正在载入首批歌曲</div><div class="pl-detail-row-artist">首批完成后即可浏览和播放</div></div></div>';
  }
  if (!tracks.length) return playlistPanelNoticeHtml(st.message || st.error || '', !!st.error);
  var viewport = Math.max(280, Number(options.viewport) || Math.min(620, Math.round((window.innerHeight || 800) * 0.72)));
  var localScrollTop = Math.max(0, Number(options.scrollTop) || 0);
  var start = Math.max(0, Math.floor(localScrollTop / PLAYLIST_DETAIL_ROW_STEP) - PLAYLIST_DETAIL_VIRTUAL_OVERSCAN);
  var maxRows = Math.ceil(viewport / PLAYLIST_DETAIL_ROW_STEP) + PLAYLIST_DETAIL_VIRTUAL_OVERSCAN * 2;
  var end = Math.min(tracks.length, start + maxRows);
  start = Math.max(0, Math.min(start, Math.max(0, tracks.length - maxRows)));
  end = Math.min(tracks.length, Math.max(end, start + maxRows));
  var rows = '<div class="pl-detail-virtual-spacer" aria-hidden="true" style="height:' + (start * PLAYLIST_DETAIL_ROW_STEP) + 'px"></div>';
  rows += tracks.slice(start, end).map(function (song, localIndex) {
    var i = start + localIndex;
    var thumb = songCoverSrc(song, 60);
    var imgTag = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
    return '<div class="pl-detail-row" data-pl-detail-row="' + i + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-detail-row-title">' + escHtml(song.name || '') + '</div>' +
      '<button type="button" class="pl-detail-row-artist" data-pl-detail-artist="' + i + '">' + escHtml(song.artist || '未知歌手') + '</button></div>' +
      detailPlaylistRowActionsHtml(song, i) +
      '</div>';
  }).join('');
  rows += '<div class="pl-detail-virtual-spacer" aria-hidden="true" style="height:' + (Math.max(0, tracks.length - end) * PLAYLIST_DETAIL_ROW_STEP) + 'px"></div>';
  if (st.error) {
    rows += '<div class="pl-detail-progress">后续歌曲载入失败，重新打开歌单可继续</div>';
  } else if (st.partial) {
    rows += '<div class="pl-detail-progress">部分平台歌单载入失败 · 已显示可用歌曲</div>';
  } else if (st.hasMore || st.loadingMore) {
    // 合并歌单为自动流式加载：持续显示"正在加载歌曲"；其余平台保持原有滚动加载提示。
    var isMergedDetail = String(st.key || '').indexOf('merged:') === 0;
    var loadingLabel = isMergedDetail
      ? '正在加载歌曲 '
      : (st.loadingMore ? '正在预载后续歌曲 ' : '继续滚动加载 ');
    rows += '<div class="pl-detail-progress"><span class="queue-hydration-spinner' + (isMergedDetail || st.loadingMore ? ' spinning' : '') + '"></span><span>' +
      loadingLabel + tracks.length + (st.total ? '/' + st.total : '') + '</span></div>';
  } else if (tracks.length > PLAYLIST_DETAIL_INITIAL_RENDER || (String(st.key || '').indexOf('merged:') === 0 && tracks.length)) {
    // 合并歌单小歌单（不足一屏）也显示加载完成信息
    rows += '<div class="pl-detail-progress">' + (String(st.key || '').indexOf('merged:') === 0 ? '已加载完成 · 共 ' : '已加载全部 ') + tracks.length + ' 首</div>';
  }
  return rows;
}
var PLAYLIST_REORDER_STORE_KEY = 'mineradio-playlist-reorder-v1';
function playlistReorderKey(pl) {
  if (!pl) return '';
  return playlistPanelKey(normalizePlaylistProvider(pl.provider), pl.id);
}
function readPlaylistReorderKeys() {
  try {
    var raw = localStorage.getItem(PLAYLIST_REORDER_STORE_KEY);
    var keys = raw ? JSON.parse(raw) : [];
    return Array.isArray(keys) ? keys.filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}
function savePlaylistReorderKeys() {
  try {
    localStorage.setItem(PLAYLIST_REORDER_STORE_KEY, JSON.stringify(userPlaylists.map(playlistReorderKey).filter(Boolean)));
  } catch (e) { }
}
function applyUserPlaylistOrder() {
  if (!userPlaylists || !userPlaylists.length) return false;
  var keys = readPlaylistReorderKeys();
  if (!keys.length) return false;
  var rank = {};
  keys.forEach(function (key, idx) {
    if (rank[key] == null) rank[key] = idx;
  });
  userPlaylists = userPlaylists.map(function (pl, idx) {
    return { pl: pl, idx: idx, rank: rank[playlistReorderKey(pl)] };
  }).sort(function (a, b) {
    var ar = a.rank;
    var br = b.rank;
    var ah = ar != null;
    var bh = br != null;
    if (ah && bh) return ar - br;
    if (ah) return -1;
    if (bh) return 1;
    return a.idx - b.idx;
  }).map(function (entry) { return entry.pl; });
  return true;
}
function moveUserPlaylistIndex(fromIdx, toIdx, opts) {
  opts = opts || {};
  fromIdx = Math.round(Number(fromIdx));
  toIdx = Math.round(Number(toIdx));
  if (!userPlaylists || !userPlaylists.length) return false;
  if (!isFinite(fromIdx) || !isFinite(toIdx)) return false;
  if (fromIdx < 0 || fromIdx >= userPlaylists.length) return false;
  toIdx = Math.max(0, Math.min(userPlaylists.length - 1, toIdx));
  if (fromIdx === toIdx) return false;
  var item = userPlaylists.splice(fromIdx, 1)[0];
  userPlaylists.splice(toIdx, 0, item);
  playlistCatalogRevision += 1;
  savePlaylistReorderKeys();
  if (opts.renderPanel !== false) renderUserPlaylistsList({ animate: false });
  if (opts.rebuildShelf !== false) safeShelfRebuild('playlist-reorder', true);
  return true;
}
function playlistTracksEndpoint(provider, id, params) {
  provider = normalizePlaylistProvider(provider);
  var query = 'id=' + encodeURIComponent(id);
  if (params) {
    Object.keys(params).forEach(function (key) {
      if (params[key] == null || params[key] === '') return;
      query += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
  }
  if (provider === 'qq') return '/api/qq/playlist/tracks?' + query;
  if (provider === 'kugou') return '/api/kugou/playlist/tracks?' + query;
  if (provider === 'qishui') return '/api/qishui/playlist/tracks?' + query;
  if (provider === 'spotify') return '/api/spotify/playlist/tracks?' + query;
  return '/api/playlist/tracks?' + query;
}
function playlistPanelDetailHtml(pl, provider, detailWindow) {
  provider = normalizePlaylistProvider(provider);
  var key = playlistPanelKey(provider, pl && pl.id);
  if (playlistPanelDetailState.key !== key) return '';
  var tracks = playlistPanelDetailState.tracks || [];
  var loading = playlistPanelDetailState.loading;
  var cover = pl && pl.cover ? (provider === 'netease' ? (pl.cover + '?param=96y96') : pl.cover) : '';
  var img = cover ? '<img class="pl-detail-cover" src="' + escHtml(cover) + '" alt="" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="pl-detail-cover"></div>';
  // 合并歌单：目录 trackCount 是各平台未去重之和（如 273），不能作为总数兜底；
  // 以打开后去重过的真实歌曲数为准，避免详情面板显示 273 而实际只有 250 首。
  var expectedTotal = provider === MERGED_PLAYLIST_PROVIDER
    ? Math.max(tracks.length, Number(playlistPanelDetailState.total) || 0)
    : Math.max(tracks.length, Number(playlistPanelDetailState.total) || Number(pl.trackCount) || 0);
  var rows = playlistPanelDetailRowsHtml(detailWindow);
  var canUncollect = !!(pl && pl.subscribed && !pl.virtual && (provider === 'netease' || provider === 'qishui' || provider === 'spotify'));
  var collectionButton = canUncollect
    ? '<button class="fx-mini-btn ghost pl-detail-top-btn" type="button" data-pl-detail-collection="0">取消收藏</button>'
    : '';
  // 删除歌单：仅自有、非"我的喜欢"、非合并歌单；无平台接口时点击后给出提示
  var canDelete = !!(pl && !pl.virtual && !pl.subscribed && !isDetailPlaylistLikedContext() && provider !== MERGED_PLAYLIST_PROVIDER);
  var deleteButton = canDelete
    ? '<button class="fx-mini-btn ghost pl-detail-top-btn pl-detail-delete-btn" type="button" data-pl-detail-delete="1">删除歌单</button>'
    : '';
  return '<div class="pl-inline-detail" data-pl-detail="' + escHtml(key) + '" style="height:' + playlistPanelDetailShellHeight() + 'px">' +
    '<div class="pl-detail-sticky">' +
    '<div class="pl-detail-head">' + img + '<div style="flex:1;min-width:0"><div class="pl-detail-title">' + escHtml(pl.name || '歌单详情') + '</div><div class="pl-detail-sub">' + escHtml((expectedTotal || tracks.length || 0) + ' 首 · ' + (pl.creator || playlistProviderName(provider))) + '</div></div><div class="pl-detail-count">' + (loading && !tracks.length ? '载入中' : (tracks.length + (expectedTotal > tracks.length ? '/' + expectedTotal : ''))) + '</div></div>' +
    '<div class="pl-detail-actions"><button class="pl-detail-play" type="button" data-pl-detail-play="' + escHtml(key) + '"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放歌单</button>' + collectionButton + deleteButton + '<button class="fx-mini-btn ghost pl-detail-top-btn" type="button" data-pl-detail-top="1">回到顶部</button></div>' +
    '</div>' +
    '<div class="pl-detail-list" data-pl-detail-scroll="' + escHtml(key) + '">' + rows + '</div>' +
    '</div>';
}
function renderPlaylistPanelDetailState() {
  renderUserPlaylistsList();
}
function scrollPlaylistPanelToTop() {
  var panel = document.getElementById('playlist-panel');
  if (!panel) return;
  // 详情是 #playlist-panel 内的内联块（pl-detail-list 为 overflow:visible），
  // 滚动轴在面板上。滚到当前详情顶部而非面板绝对顶部——合并歌单详情可能
  // 不在面板首项（如"我的歌单"栏目之下），滚到 0 会把详情滚出视野，
  // 表现为"回到顶部没响应"。详情行虚拟化由 panel.scrollTop 几何驱动，
  // 滚动后详情列表自动回到首屏。
  scrollPlaylistPanelDetailIntoView(playlistPanelDetailState && playlistPanelDetailState.key);
}
function scrollPlaylistPanelDetailIntoView(key) {
  var panel = document.getElementById('playlist-panel');
  if (!panel || !key) return;
  requestAnimationFrame(function () {
    // 用虚拟列表缓存计算详情在列表内容中的绝对偏移。不能用 DOM 的
    // detail.previousElementSibling.offsetTop：详情滚出视口后，虚拟化渲染
    // 会把 anchor 换成模拟高度的 .playlist-virtual-spacer，其 offsetTop 随
    // 视口变化，算出的 top ≈ 当前 scrollTop，导致"回到顶部只移动一点点"。
    var cache = typeof playlistPanelBuildVirtualEntries === 'function' ? playlistPanelBuildVirtualEntries() : null;
    var detailIndex = -1;
    if (cache && Array.isArray(cache.entries)) {
      cache.entries.some(function (entry, i) {
        if (entry && entry.type === 'detail' && entry.pl && playlistPanelKey(entry.provider, entry.pl.id) === key) {
          detailIndex = i;
          return true;
        }
        return false;
      });
    }
    if (detailIndex < 0 || !cache || !Array.isArray(cache.offsets)) return;
    var toolbar = panel.querySelector('.queue-toolbar');
    var safeOffset = 126;
    if (toolbar) {
      var toolbarTop = 82;
      try { toolbarTop = parseFloat(getComputedStyle(toolbar).top) || toolbarTop; } catch (e) { }
      safeOffset = Math.max(safeOffset, toolbarTop + toolbar.offsetHeight + 12);
    }
    var top = Math.max(0, (cache.offsets[detailIndex] || 0) - safeOffset);
    // 瞬时定位而非 behavior:'smooth'：smooth 第一帧触发 panel scroll 事件 →
    // rAF 虚拟列表重建（preserveScroll 恢复当前 scrollTop）会中断 smooth 动画，
    // 滚动停在第一帧附近（"回到顶部只移动一点点"）。瞬时赋值一次到位，
    // 后续渲染的 preserveScroll 恢复的值就是目标值本身，互不干扰。
    panel.scrollTop = top;
  });
}
function cancelPlaylistPanelDetailRequest() {
  if (playlistPanelDetailState.warmTimer) clearTimeout(playlistPanelDetailState.warmTimer);
  playlistPanelDetailState.warmTimer = 0;
  if (playlistPanelDetailState.controller) {
    try { playlistPanelDetailState.controller.abort(); } catch (e) { }
  }
  playlistPanelDetailState.controller = null;
}
function appendPlaylistPanelDetailTracks(target, incoming) {
  var seen = Object.create(null);
  (target || []).forEach(function (song, index) { seen[queuePanelItemKey(song, 'old:' + index)] = true; });
  var added = 0;
  (incoming || []).forEach(function (song, index) {
    var key = queuePanelItemKey(song, 'new:' + index);
    if (!song || seen[key]) return;
    seen[key] = true;
    target.push(song);
    added += 1;
  });
  return added;
}
function renderPlaylistPanelDetailRows() {
  if (!playlistPanelDetailState.key) return;
  renderUserPlaylistsList({ animate: false, preserveScroll: true });
}
function bindPlaylistPanelDetailScroller() {
  // 歌单详情与左栏共用 #playlist-panel 的单一滚动轴；行窗口由外层滚动位置驱动。
}
async function loadMorePlaylistPanelDetailTracks(reason) {
  var st = playlistPanelDetailState;
  if (!st.key || st.loadingMore || (reason !== 'initial' && !st.hasMore)) return false;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  var offset = reason === 'initial' ? 0 : Math.max(0, Number(st.nextOffset) || st.tracks.length);
  var token = st.token;
  var controller = window.AbortController ? new AbortController() : null;
  // 合并歌单为一次性全量加载，可能超过普通请求的 12s，不设请求级 abort；
  // 其余平台歌单保持原有 12s 超时。
  var timer = controller && provider !== MERGED_PLAYLIST_PROVIDER ? setTimeout(function () { controller.abort(); }, 12000) : 0;
  st.controller = controller;
  st.loadingMore = reason !== 'initial';
  if (st.loadingMore) renderPlaylistPanelDetailRows();
  try {
    if (provider === MERGED_PLAYLIST_PROVIDER) {
      if (!st.mergedPager) {
        var cacheResult = await prepareMergedPlaylistCache(st.playlist, { signal: controller ? controller.signal : null, stream: true });
        st.mergedPager = cacheResult && cacheResult.snapshot
          ? createMergedPlaylistCachedPager(cacheResult.snapshot)
          : createMergedPlaylistPagerForRecord(st.playlist, controller ? controller.signal : null);
      }
    }
    // 合并歌单流式加载：每次只拉一页（首屏立即展示），由 warm 调度自动
    // 连续拉取直到全部，不再一次性 loadAll 等全量同步完成。
    var r = provider === MERGED_PLAYLIST_PROVIDER
      ? await fetchMergedPlaylistPage(st.mergedPager, PLAYLIST_DETAIL_BATCH_SIZE)
      : await apiJson(playlistTracksEndpoint(provider, pid, { limit: PLAYLIST_DETAIL_BATCH_SIZE, offset: offset }), controller ? { signal: controller.signal } : { timeoutMs: 12000 });
    if (playlistPanelDetailState.token !== token || playlistPanelDetailState.key !== st.key) return false;
    var rawTracks = r && r.tracks || [];
    if (r && r.error && !rawTracks.length) throw new Error(r.message || r.error);
    var mapped = rawTracks.map(cloneSong);
    var added = appendPlaylistPanelDetailTracks(st.tracks, mapped);
    var responseTotal = Number(r && (r.total || (r.playlist && r.playlist.trackCount))) || 0;
    // 合并歌单：缓存分页器（r.cached）返回的 total 是去重后真实数，直接沿用
    // （避免打开瞬间的 250 被首屏 48 回退）；网络分页器流式加载时以已加载的
    // 实际数为准，不残留未去重预估。
    st.total = provider === MERGED_PLAYLIST_PROVIDER
      ? (r && r.cached
        ? Math.max(st.total || 0, Number(r.total) || 0)
        : st.tracks.length)
      : Math.max(st.total || 0, responseTotal, st.tracks.length);
    st.nextOffset = provider === MERGED_PLAYLIST_PROVIDER
      ? Math.max(st.tracks.length, Number(r && r.nextOffset) || 0)
      : Math.max(offset + rawTracks.length, Number(r && r.nextOffset) || 0);
    st.hasMore = !!(r && r.hasMore);
    if (!rawTracks.length || (!added && st.nextOffset <= offset)) st.hasMore = false;
    st.loading = false;
    st.loadingMore = false;
    st.error = (r && r.error) || '';
    st.partial = st.partial || !!(r && r.partial);
    st.message = st.partial ? '部分平台歌单载入失败，已显示可用歌曲' : ((r && (r.message || r.warning)) || '');
    if (r && r.playlist) st.playlist = Object.assign({}, st.playlist || {}, r.playlist);
    if (reason === 'initial') {
      renderPlaylistPanelDetailState();
      scrollPlaylistPanelDetailIntoView(st.key);
      if (st.hasMore) {
        st.warmTimer = setTimeout(function () {
          st.warmTimer = 0;
          if (playlistPanelDetailState.token === token && playlistPanelDetailState.key === st.key) loadMorePlaylistPanelDetailTracks('warm');
        }, 320);
      }
    } else {
      renderPlaylistPanelDetailRows();
      // 合并歌单流式加载：自动继续拉取直到全部（不依赖滚动到底部）。
      // 缓存分页器为内存切片（快），网络分页器逐页拉取（边加载边展示）。
      if (provider === MERGED_PLAYLIST_PROVIDER && st.hasMore && !st.loadingMore && st.mergedAutoPages < PLAYLIST_DETAIL_MERGED_AUTO_PAGE_LIMIT
          && playlistPanelDetailState.token === token && playlistPanelDetailState.key === st.key) {
        st.mergedAutoPages += 1;
        if (st.warmTimer) clearTimeout(st.warmTimer);
        st.warmTimer = setTimeout(function () {
          st.warmTimer = 0;
          if (playlistPanelDetailState.token === token && playlistPanelDetailState.key === st.key) loadMorePlaylistPanelDetailTracks('warm');
        }, 120);
      }
    }
    return added > 0;
  } catch (e) {
    if (playlistPanelDetailState.token !== token || (e && e.name === 'AbortError')) return false;
    console.warn('[PlaylistPanelDetailPage]', pid, reason, e);
    st.loading = false;
    st.loadingMore = false;
    st.hasMore = false;
    st.error = 'PLAYLIST_DETAIL_PAGE_FAILED';
    st.message = st.tracks.length ? '后续歌曲载入失败，可继续滚动重试' : '歌单详情加载失败，请稍后重试';
    if (reason === 'initial') renderPlaylistPanelDetailState();
    else renderPlaylistPanelDetailRows();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (playlistPanelDetailState.token === token && playlistPanelDetailState.controller === controller) playlistPanelDetailState.controller = null;
  }
}
async function openPlaylistPanelDetail(provider, pid, title) {
  if (!pid) return;
  provider = normalizePlaylistProvider(provider);
  var key = playlistPanelKey(provider, pid);
  var pl = userPlaylists.find(function (item) { return playlistPanelKey(normalizePlaylistProvider(item.provider), item.id) === key; }) || { id: pid, provider: provider, name: title || '歌单详情' };
  if (playlistPanelDetailState.key === key) {
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    playlistPanelDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
    playlistPanelDetailState.error = '';
    playlistPanelDetailState.message = '';
    renderPlaylistPanelDetailState();
    return;
  }
  cancelPlaylistPanelDetailRequest();
  var token = ++playlistPanelDetailState.token;
  // 合并歌单：初始 total 不用目录 trackCount（无缓存时是各平台未去重之和，如 273）；
  // 有缓存匹配时用去重后真实数，否则置 0（加载中显示"载入中"，加载完成后以实际数为准）。
  var initialTotal = provider === MERGED_PLAYLIST_PROVIDER
    ? (mergedPlaylistCachedTrackCountFor(pl.sources || []) || 0)
    : (Number(pl.trackCount) || 0);
  playlistPanelDetailState = { key: key, loading: true, loadingMore: false, playlist: pl, tracks: [], token: token, total: initialTotal, nextOffset: 0, hasMore: true, scrollTop: 0, controller: null, warmTimer: 0, mergedPager: null, mergedAutoPages: 0, partial: false, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
  renderPlaylistPanelDetailState();
  scrollPlaylistPanelDetailIntoView(key);
  await loadMorePlaylistPanelDetailTracks('initial');
}
function playPlaylistPanelDetail() {
  var st = playlistPanelDetailState;
  if (!st || !st.key) return;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, st.playlist && st.playlist.name || '');
}
async function togglePlaylistPanelCollection(collected) {
  var state = playlistPanelDetailState;
  if (!state || !state.key || !state.playlist) return;
  var parts = state.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var id = parts.slice(1).join(':');
  var endpoint = provider === 'netease'
    ? '/api/playlist/subscribe'
    : (provider === 'qishui'
      ? '/api/qishui/playlist/collect'
      : (provider === 'spotify' ? '/api/spotify/playlist/collect' : ''));
  if (!endpoint) {
    showToast(playlistProviderName(provider) + '暂不支持写回歌单收藏');
    return;
  }
  try {
    var result = await apiJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id,
        playlistId: id,
        subscribed: !!collected,
        collected: !!collected,
        spotifyUri: state.playlist.spotifyUri || '',
      })
    });
    if (!result || result.error || result.success === false) throw new Error(result && (result.message || result.error) || 'PLAYLIST_COLLECTION_FAILED');
    showToast(collected ? '歌单已收藏' : '已取消收藏歌单');
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    await refreshUserPlaylists(true);
    renderPlaylistPanelDetailState();
  } catch (err) {
    showToast(/SCOPE|PERMISSION/i.test(String(err && err.message || ''))
      ? '请重新授权后再修改歌单收藏'
      : '歌单收藏操作失败');
  }
}
function playPlaylistPanelDetailTrack(index) {
  var tracks = playlistPanelDetailState.tracks || [];
  if (!tracks[index]) return;
  var parts = playlistPanelDetailState.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, playlistPanelDetailState.playlist && playlistPanelDetailState.playlist.name || '', {
    seedTracks: tracks,
    startIndex: index,
    total: playlistPanelDetailState.total,
    nextOffset: playlistPanelDetailState.nextOffset,
    hasMore: playlistPanelDetailState.hasMore,
    mergedPager: playlistPanelDetailState.mergedPager,
    partial: playlistPanelDetailState.partial,
    preserveHomeState: true
  });
}
function openPlaylistPanelDetailArtist(index) {
  var song = playlistPanelDetailState.tracks && playlistPanelDetailState.tracks[index];
  if (song) openArtistDetailForSong(song);
}
function growPlaylistPanelDetailRenderLimit(amount) {
  return loadMorePlaylistPanelDetailTracks('manual');
}
function maybeGrowPlaylistPanelDetailRenderLimit() {
  var panel = document.getElementById('playlist-panel');
  var detail = panel && panel.querySelector('.pl-inline-detail[data-pl-detail]');
  if (!panel || !detail || !playlistPanelDetailState.hasMore || playlistPanelDetailState.loadingMore) return;
  var panelRect = panel.getBoundingClientRect();
  var detailRect = detail.getBoundingClientRect();
  if (detailRect.bottom <= panelRect.bottom + PLAYLIST_DETAIL_ROW_STEP * 8) loadMorePlaylistPanelDetailTracks('scroll');
}
function resetPlaylistPanelRenderLimit() {
  playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
}
var playlistPanelVirtualCache = { revision: -1, detailKey: '', detailSig: '', entries: [], offsets: [0], totalHeight: 0, raf: 0 };
function playlistPanelDetailShellHeight() {
  var st = playlistPanelDetailState || {};
  var rows = Math.max(st.loading && !(st.tracks && st.tracks.length) ? 1 : 0, st.tracks && st.tracks.length || 0);
  var noticeHeight = rows ? 0 : 74;
  var footerHeight = st.error || st.hasMore || st.loadingMore || rows > PLAYLIST_DETAIL_INITIAL_RENDER ? PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT : 12;
  return PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT + rows * PLAYLIST_DETAIL_ROW_STEP + noticeHeight + footerHeight;
}
function playlistPanelGroupKey(pl) {
  return normalizePlaylistProvider(pl && pl.provider);
}
function playlistPanelBuildVirtualEntries() {
  var detailSig = [
    playlistPanelDetailState.key || '',
    playlistPanelDetailState.loading ? 1 : 0,
    playlistPanelDetailState.loadingMore ? 1 : 0,
    playlistPanelDetailState.tracks && playlistPanelDetailState.tracks.length || 0,
    playlistPanelDetailState.total || 0,
    playlistPanelDetailState.hasMore ? 1 : 0,
    playlistPanelDetailState.error || ''
  ].join('|');
  if (playlistPanelVirtualCache.revision === playlistCatalogRevision &&
      playlistPanelVirtualCache.detailKey === playlistPanelDetailState.key &&
      playlistPanelVirtualCache.detailSig === detailSig) return playlistPanelVirtualCache;
  var labels = { netease: '网易云歌单', qq: 'QQ 音乐歌单', kugou: '酷狗音乐歌单', qishui: '汽水音乐歌单', spotify: 'Spotify 歌单', merged: '跨平台合并歌单' };
  // merged 放在首位：开启合并歌单时 userPlaylists 只含合并歌单记录，
  // 分组必须遍历 merged，否则合并歌单卡永远不会渲染（列表为空）。
  var order = ['merged', 'netease', 'qq', 'kugou', 'qishui', 'spotify'];
  var groups = { merged: [], netease: [], qq: [], kugou: [], qishui: [], spotify: [] };
  userPlaylists.forEach(function (pl, sourceIndex) {
    var key = playlistPanelGroupKey(pl);
    if (!groups[key]) groups[key] = [];
    groups[key].push({ pl: pl, sourceIndex: sourceIndex });
  });
  var entries = [];
  order.forEach(function (key) {
    var items = (groups[key] || []).sort(function (a, b) {
      var priority = playlistCardPriority(a.pl) - playlistCardPriority(b.pl);
      return priority || (a.sourceIndex - b.sourceIndex);
    });
    if (!items.length) return;
    entries.push({ type: 'label', key: key, label: labels[key] || key, height: 31 });
    items.forEach(function (entry) {
      entries.push({ type: 'card', pl: entry.pl, sourceIndex: entry.sourceIndex, height: 69 });
      var cardKey = playlistPanelKey(normalizePlaylistProvider(entry.pl.provider), entry.pl.id);
      if (playlistPanelDetailState.key === cardKey) {
        entries.push({ type: 'detail', pl: entry.pl, provider: normalizePlaylistProvider(entry.pl.provider), height: playlistPanelDetailShellHeight() });
      }
    });
  });
  var offsets = [0];
  entries.forEach(function (entry) { offsets.push(offsets[offsets.length - 1] + entry.height); });
  playlistPanelVirtualCache = {
    revision: playlistCatalogRevision,
    detailKey: playlistPanelDetailState.key,
    detailSig: detailSig,
    entries: entries,
    offsets: offsets,
    totalHeight: offsets[offsets.length - 1] || 0,
    raf: playlistPanelVirtualCache.raf || 0
  };
  return playlistPanelVirtualCache;
}
function playlistPanelOffsetIndex(offsets, value) {
  var lo = 0, hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    var mid = Math.floor((lo + hi + 1) / 2);
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(offsets.length - 2, lo));
}
function playlistCatalogFooterHtml() {
  var state = playlistCatalogSyncState || {};
  var providerStates = state.providers || {};
  var totals = Object.keys(providerStates).reduce(function (acc, key) {
    var item = providerStates[key] || {};
    acc.loaded += Number(item.loaded) || 0;
    acc.total += Math.max(Number(item.total) || 0, Number(item.loaded) || 0);
    if (item.hasMore || item.loading) acc.pending = true;
    return acc;
  }, { loaded: 0, total: 0, pending: !!state.loading });
  if (!totals.pending && !state.error) return '';
  var label = state.error
    ? ('部分歌单载入失败 · 已显示 ' + userPlaylists.length + ' 个')
    : ('正在后台载入歌单 · ' + totals.loaded + (totals.total ? '/' + totals.total : ''));
  // spinner 只在真正加载中（pending）时转；纯错误提示为静态，避免误导
  return '<div class="playlist-catalog-status"><span class="queue-hydration-spinner' + (totals.pending ? ' spinning' : '') + '"></span><span>' + label + '</span></div>';
}
function schedulePlaylistPanelVirtualRender() {
  if (playlistPanelVirtualCache.raf) return;
  playlistPanelVirtualCache.raf = requestAnimationFrame(function () {
    playlistPanelVirtualCache.raf = 0;
    if (queueViewTab !== 'playlists') return;
    renderUserPlaylistsList({ animate: false, preserveScroll: true });
  });
}
function bindPlaylistPanelLazyRender() {
  var panel = document.getElementById('playlist-panel');
  bindMiniQueueLazyRender();
  if (!panel || playlistPanelLazyBound) return;
  playlistPanelLazyBound = true;
  panel.addEventListener('scroll', function () {
    if (queueViewTab === 'queue') {
      scheduleQueuePanelVirtualRender();
      maybeRequestPlaylistQueuePageFromScroller(panel);
    }
    if (queueViewTab === 'playlists') {
      schedulePlaylistPanelVirtualRender();
      maybeGrowPlaylistPanelDetailRenderLimit();
    }
  }, { passive: true });
}
function renderUserPlaylistsList(opts) {
  opts = opts || {};
  var $pl = document.getElementById('pl-list');
  var seq = ++playlistRenderSeq;
  if (!userPlaylists.length) {
    $pl.innerHTML = playlistCatalogSyncState && playlistCatalogSyncState.loading
      ? miniQueueSkeleton() + playlistCatalogFooterHtml()
      : '<div style="text-align:center;padding:24px 0;color:rgba(255,255,255,.32);font-size:11.5px">未找到歌单</div>';
    return;
  }
  var panel = document.getElementById('playlist-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  function playlistCardHtml(pl, sourceIndex) {
    var provider = normalizePlaylistProvider(pl.provider);
    var providerLabel = playlistProviderLabel(provider);
    var thumb = pl.cover ? (provider === 'netease' ? (pl.cover + '?param=88y88') : pl.cover) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.06);flex-shrink:0"></div>';
    var key = playlistPanelKey(provider, pl.id);
    var isExpanded = playlistPanelDetailState.key === key;
    var expanded = isExpanded ? ' expanded' : '';
    return '<div class="pl-card' + expanded + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" data-playlist-provider="' + provider + '" data-playlist-id="' + escHtml(String(pl.id || '')) + '" data-playlist-title="' + escHtml(pl.name || '') + '" data-playlist-index="' + sourceIndex + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pl.name) + '<span class="tag-source ' + provider + '" style="margin-left:6px;vertical-align:1px">' + providerLabel + '</span></div><div class="pl-sub">' + pl.trackCount + ' 首 · ' + escHtml(pl.creator || '') + '</div></div>' +
      '</div>';
  }
  var cache = playlistPanelBuildVirtualEntries();
  var listRect = $pl.getBoundingClientRect();
  var panelRect = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : { top: 0 };
  var visibleTop = panel ? Math.max(0, panelRect.top - listRect.top) : 0;
  var viewport = Math.max(420, Number(panel && panel.clientHeight) || 620);
  var start = playlistPanelOffsetIndex(cache.offsets, Math.max(0, visibleTop - PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX));
  var end = Math.min(cache.entries.length, playlistPanelOffsetIndex(cache.offsets, visibleTop + viewport + PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX) + 1);
  var topHeight = cache.offsets[start] || 0;
  var bottomHeight = Math.max(0, cache.totalHeight - (cache.offsets[end] || cache.totalHeight));
  var html = '<div class="playlist-virtual-spacer" aria-hidden="true" style="height:' + Math.round(topHeight) + 'px"></div>';
  for (var entryIndex = start; entryIndex < end; entryIndex++) {
    var entry = cache.entries[entryIndex];
    if (entry.type === 'label') html += '<div class="pl-section-label">' + entry.label + '</div>';
    else if (entry.type === 'card') html += playlistCardHtml(entry.pl, entry.sourceIndex);
    else if (entry.type === 'detail') {
      var entryTop = cache.offsets[entryIndex] || 0;
      var detailRowScrollTop = Math.max(0, visibleTop - entryTop - PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT);
      html += playlistPanelDetailHtml(entry.pl, entry.provider, { scrollTop: detailRowScrollTop, viewport: viewport });
    }
  }
  html += '<div class="playlist-virtual-spacer" aria-hidden="true" style="height:' + Math.round(bottomHeight) + 'px"></div>' + playlistCatalogFooterHtml();
  $pl.innerHTML = html;
  if (panel && opts.preserveScroll) panel.scrollTop = keepTop;
  bindPlaylistPanelDetailScroller();
  if (typeof requestNextPlaylistCatalogPage === 'function' && end >= cache.entries.length - 8) requestNextPlaylistCatalogPage('panel-near-end');
  if (opts.animate && seq === playlistRenderSeq) animateVisiblePanelList($pl, '.pl-card', document.getElementById('playlist-panel'));
}
function renderMyPodcastCollections(opts) {
  opts = opts || {};
  var $pod = document.getElementById('podcast-list');
  if (!$pod) return;
  if (!loginStatus.loggedIn) {
    $pod.innerHTML = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">登录后显示我的播客</div>';
    return;
  }
  var items = myPodcastCollections || [];
  if (!items.length) {
    $pod.innerHTML = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无播客数据</div>';
    return;
  }
  $pod.innerHTML = items.map(function (pc) {
    var thumb = pc.cover ? coverUrlWithSize(pc.cover, 88) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>';
    return '<div class="pl-card podcast-card" data-podcast-key="' + escHtml(pc.key || '') + '" data-podcast-title="' + escHtml(pc.title || '') + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pc.title || '') + '</div><div class="pl-sub">' + (pc.count || 0) + ' 项 · ' + escHtml(pc.sub || '') + '</div></div>' +
      '</div>';
  }).join('');
  if (opts.animate) animateVisiblePanelList($pod, '.pl-card', document.getElementById('playlist-panel'));
}
document.getElementById('pl-list').addEventListener('click', function (e) {
  var loadMore = e.target && e.target.closest ? e.target.closest('[data-pl-load-more]') : null;
  if (loadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelRenderLimit();
    return;
  }
  var detailLoadMore = e.target && e.target.closest ? e.target.closest('[data-pl-detail-load-more]') : null;
  if (detailLoadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelDetailRenderLimit();
    return;
  }
  var detailTop = e.target && e.target.closest ? e.target.closest('[data-pl-detail-top]') : null;
  if (detailTop) {
    e.preventDefault();
    e.stopPropagation();
    scrollPlaylistPanelToTop();
    return;
  }
  var playDetail = e.target && e.target.closest ? e.target.closest('[data-pl-detail-play]') : null;
  if (playDetail) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetail();
    return;
  }
  var collection = e.target && e.target.closest ? e.target.closest('[data-pl-detail-collection]') : null;
  if (collection) {
    e.preventDefault();
    e.stopPropagation();
    togglePlaylistPanelCollection(collection.getAttribute('data-pl-detail-collection') === '1');
    return;
  }
  var deleteBtn = e.target && e.target.closest ? e.target.closest('[data-pl-detail-delete]') : null;
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteDetailPlaylist();
    return;
  }
  var artist = e.target && e.target.closest ? e.target.closest('[data-pl-detail-artist]') : null;
  if (artist) {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistPanelDetailArtist(Number(artist.getAttribute('data-pl-detail-artist')));
    return;
  }
  var row = e.target && e.target.closest ? e.target.closest('[data-pl-detail-row]') : null;
  if (row) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetailTrack(Number(row.getAttribute('data-pl-detail-row')));
    return;
  }
  var card = e.target && e.target.closest ? e.target.closest('.pl-card') : null;
  if (!card) return;
  var provider = card.getAttribute('data-playlist-provider') || 'netease';
  var pid = card.getAttribute('data-playlist-id') || '';
  openPlaylistPanelDetail(provider, pid, card.getAttribute('data-playlist-title') || '');
});
