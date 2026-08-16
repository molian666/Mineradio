// ============================================================
//  Windows 媒体会话（SMTC）/ 系统媒体键接入
//
//  Chromium 的 navigator.mediaSession 会映射到 Windows 系统媒体
//  Transport Controls（SMTC）：键盘媒体键、系统音量 OSD 封面与进度、
//  锁屏媒体控件、蓝牙耳机 / 车载的播放控制。
//
//  本模块零依赖运行在渲染层（Electron 42 / Chromium 已支持
//  navigator.mediaSession）。由于播放器使用 plain <audio>（全局
//  audio），且桌面模式下渲染器会被隐藏 / 重新布局，本模块通过
//  低频轮询 + 显式同步入口双保险驱动：
//   - syncSystemMediaSessionNow()：在任何"切歌 / 播放状态变化"收敛点调用，
//     立刻推送元数据、播放状态与当前进度。
//   - setSystemMediaSessionPlaybackState(playing)：只更新播放状态。
//
//  为避免引入循环依赖与契约风险，本模块对外只暴露带 typeof 守卫的
//  全局函数，绝不 throw；不支持 navigator.mediaSession 时自动退化为
//  空操作。
// ============================================================
var systemMediaSessionSupported = !!(typeof navigator !== 'undefined' && navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function');
var systemMediaSessionActionsBound = false;
var systemMediaSessionTimer = null;
var systemMediaSessionLastSongKey = '';
var systemMediaSessionLastState = '';
var systemMediaSessionLastPositionSec = -1;
var systemMediaSessionLastSyncAt = 0;
var SYSTEM_MEDIA_SESSION_POSITION_RESYNC_MS = 1000;
var SYSTEM_MEDIA_SESSION_POLL_MS = 700;

function systemMediaSessionNowPlayingSong() {
  if (typeof currentCoverSong === 'function') {
    var song = currentCoverSong();
    if (song) return song;
  }
  if (typeof playQueue !== 'undefined' && Array.isArray(playQueue) && typeof currentIdx !== 'undefined' && currentIdx >= 0 && currentIdx < playQueue.length) {
    return playQueue[currentIdx];
  }
  return null;
}

function systemMediaSessionPlayingNow() {
  if (typeof playing !== 'undefined') return !!playing;
  if (typeof audio !== 'undefined' && audio) return !!(audio.src && !audio.paused && !audio.ended);
  return false;
}

function systemMediaSessionSongArtwork(song) {
  var src = '';
  if (typeof songCoverSrc === 'function' && song) src = songCoverSrc(song, 512);
  if (!src && song) src = String(song.cover || song.picUrl || song.albumCover || song.coverUrl || '');
  if (!src) return [];
  // 内联 data:/blob: 无法被系统加载为 artwork，直接忽略；代理后的 http(s)
  // 封面路径多数可直接被 Chromium 抓取。
  if (/^data:/i.test(src) || /^blob:/i.test(src) || /^mineradio-local:/i.test(src)) return [];
  return [{ src: src, sizes: '512x512', type: 'image/jpeg' }];
}

function systemMediaSessionPushMetadata() {
  if (!systemMediaSessionSupported) return;
  var song = systemMediaSessionNowPlayingSong() || {};
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || song.singer || '').trim();
  var album = String(song.album || '').trim();
  if (!title) return;
  var metadata = {
    title: title,
    artist: artist || '未知歌手',
    album: album,
    artwork: systemMediaSessionSongArtwork(song)
  };
  try {
    navigator.mediaSession.metadata = new MediaMetadata(metadata);
  } catch (e) {
    // 个别环境 MediaMetadata 可用性异常时仅保留标题字段
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: artist, album: album }); } catch (e2) { }
  }
}

function systemMediaSessionPushPosition(force) {
  if (!systemMediaSessionSupported) return;
  var song = systemMediaSessionNowPlayingSong();
  if (!song) return;
  var durationSec = typeof getPlaybackDurationSeconds === 'function' ? getPlaybackDurationSeconds() : 0;
  var currentSec = typeof getPlaybackCurrentSeconds === 'function' ? getPlaybackCurrentSeconds() : 0;
  if (!(durationSec > 0)) durationSec = playbackDurationFromSong && typeof playbackDurationFromSong === 'function' ? playbackDurationFromSong(song) : 0;
  if (!(durationSec > 0)) return;
  if (currentSec > durationSec) currentSec = durationSec;
  var drift = Math.abs(currentSec - systemMediaSessionLastPositionSec);
  if (!force && systemMediaSessionLastPositionSec >= 0 && drift < 1 && (Date.now() - systemMediaSessionLastSyncAt) < SYSTEM_MEDIA_SESSION_POSITION_RESYNC_MS) {
    return;
  }
  systemMediaSessionLastPositionSec = currentSec;
  systemMediaSessionLastSyncAt = Date.now();
  try {
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      navigator.mediaSession.setPositionState({
        duration: durationSec,
        playbackRate: Math.max(0, Number((typeof audio !== 'undefined' && audio && audio.playbackRate) || 1) || 1),
        position: Math.max(0, currentSec)
      });
    }
  } catch (e) {
    // 不支持 setPositionState 的旧环境忽略
  }
}

function systemMediaSessionPullState() {
  return systemMediaSessionPlayingNow();
}

function systemMediaSessionPushPlaybackState() {
  if (!systemMediaSessionSupported) return;
  var isPlaying = systemMediaSessionPullState();
  var next = isPlaying ? 'playing' : 'paused';
  systemMediaSessionLastState = next;
  try {
    navigator.mediaSession.playbackState = next;
  } catch (e) { }
}

function systemMediaSessionSyncAll(reason) {
  if (!systemMediaSessionSupported) return;
  var song = systemMediaSessionNowPlayingSong();
  var key = song ? (typeof queueItemKey === 'function' ? queueItemKey(song) : (song.name || '') + '|' + (song.artist || '')) : '';
  if (key && key !== systemMediaSessionLastSongKey) {
    systemMediaSessionLastSongKey = key;
    systemMediaSessionLastPositionSec = -1;
    systemMediaSessionLastSyncAt = 0;
    systemMediaSessionPushMetadata();
  }
  systemMediaSessionPushPlaybackState();
  systemMediaSessionPushPosition(false);
  void reason;
}

function executeSystemMediaSessionAction(action) {
  if (action === 'togglePlay') {
    if (typeof togglePlay === 'function') togglePlay();
    return;
  }
  if (action === 'play') {
    if (typeof togglePlay === 'function') {
      // togglePlay 内部判断：已在播放则暂停。系统"播放"应保证开始播放。
      var isPlaying = systemMediaSessionPlayingNow();
      if (!isPlaying) togglePlay();
    } else if (typeof audio !== 'undefined' && audio && audio.src) {
      audio.play().catch(function () { });
    }
    return;
  }
  if (action === 'pause') {
    if (typeof fadeOutAndPauseAudio === 'function') {
      fadeOutAndPauseAudio();
    } else if (typeof audio !== 'undefined' && audio) {
      try { audio.pause(); } catch (e) { }
    }
    return;
  }
  if (action === 'previoustrack') {
    if (typeof prevTrack === 'function') prevTrack(true);
    return;
  }
  if (action === 'nexttrack') {
    if (typeof nextTrack === 'function') nextTrack(true);
    return;
  }
  if (action === 'stop') {
    if (typeof fadeOutAndPauseAudio === 'function') fadeOutAndPauseAudio();
    else if (typeof audio !== 'undefined' && audio) { try { audio.pause(); } catch (e) { } }
    return;
  }
}

function systemMediaSessionHandleSeek(deltaSec) {
  if (!audio) return;
  var currentSec = typeof getPlaybackCurrentSeconds === 'function' ? getPlaybackCurrentSeconds() : 0;
  var durationSec = typeof getPlaybackDurationSeconds === 'function' ? getPlaybackDurationSeconds() : 0;
  var target = Math.max(0, Math.min(durationSec || currentSec, currentSec + (Number(deltaSec) || 0)));
  try {
    audio.currentTime = target;
  } catch (e) { }
  if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  systemMediaSessionLastPositionSec = -1;
  systemMediaSessionPushPosition(true);
}

function systemMediaSessionHandleSeekTo(details) {
  if (!audio || !details) return;
  if (typeof details.seekTime !== 'number' && isFinite(Number(details.seekTime))) {
    details = Object.assign({}, details, { seekTime: Number(details.seekTime) });
  }
  var target = Math.max(0, Number(details.seekTime) || 0);
  var durationSec = typeof getPlaybackDurationSeconds === 'function' ? getPlaybackDurationSeconds() : 0;
  if (durationSec > 0 && target > durationSec) target = durationSec;
  try {
    audio.currentTime = target;
  } catch (e) { }
  if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  systemMediaSessionLastPositionSec = -1;
  systemMediaSessionPushPosition(true);
}

function bindSystemMediaSessionActions() {
  if (!systemMediaSessionSupported || systemMediaSessionActionsBound) return false;
  systemMediaSessionActionsBound = true;
  var specs = [
    { action: 'play', handler: function () { executeSystemMediaSessionAction('play'); } },
    { action: 'pause', handler: function () { executeSystemMediaSessionAction('pause'); } },
    { action: 'previoustrack', handler: function () { executeSystemMediaSessionAction('previoustrack'); } },
    { action: 'nexttrack', handler: function () { executeSystemMediaSessionAction('nexttrack'); } },
    { action: 'stop', handler: function () { executeSystemMediaSessionAction('stop'); } },
    { action: 'seekto', handler: function (details) { systemMediaSessionHandleSeekTo(details); } },
    { action: 'seekbackward', handler: function (details) {
      var offset = Number(details && details.seekOffset);
      if (!isFinite(offset) || offset <= 0) offset = 10;
      systemMediaSessionHandleSeek(-offset);
    } },
    { action: 'seekforward', handler: function (details) {
      systemMediaSessionHandleSeek(Math.max(0, Number(details && details.seekOffset) || 10));
    } }
  ];
  specs.forEach(function (spec) {
    try {
      navigator.mediaSession.setActionHandler(spec.action, spec.handler);
    } catch (e) { }
  });
  return true;
}

// 兜底轮询：audio 元素可能在桌面模式下被重建 / 重新布局，且切换不经过
// 既有收敛点不可靠。低频轮询确保 SMTC 进度与状态始终贴近真实播放器。
function scheduleSystemMediaSessionPoll() {
  if (!systemMediaSessionSupported) return;
  if (systemMediaSessionTimer) return;
  systemMediaSessionTimer = setInterval(function () {
    var isPlaying = systemMediaSessionPullState();
    if (!isPlaying && systemMediaSessionLastState !== 'playing') return;
    systemMediaSessionSyncAll('poll');
  }, SYSTEM_MEDIA_SESSION_POLL_MS);
}

function unregisterSystemMediaSessionPoll() {
  if (systemMediaSessionTimer) {
    clearInterval(systemMediaSessionTimer);
    systemMediaSessionTimer = null;
  }
}

// 对外同步入口：在切歌 / 播放状态变化收敛点调用。
function syncSystemMediaSessionNow(reason) {
  if (!systemMediaSessionSupported) return;
  systemMediaSessionSyncAll(reason);
}

// 对外同步入口：只更新播放状态（如 setPlayIcon 收敛点）。
// 由调用方在"播放/暂停状态刚变化"的瞬间传入目标状态，直接推送。
function setSystemMediaSessionPlaybackState(isPlaying) {
  if (!systemMediaSessionSupported) return;
  var next = isPlaying ? 'playing' : 'paused';
  systemMediaSessionLastState = next;
  try {
    navigator.mediaSession.playbackState = next;
  } catch (e) { }
}

// 对外入口：更新当前歌曲元数据（如切歌 / 恢复播放时）。
function refreshSystemMediaSessionMetadata(reason) {
  if (!systemMediaSessionSupported) return;
  systemMediaSessionLastSongKey = '';
  systemMediaSessionSyncAll(reason);
}

function initSystemMediaSession() {
  if (!systemMediaSessionSupported) return;
  bindSystemMediaSessionActions();
  systemMediaSessionSyncAll('init');
  scheduleSystemMediaSessionPoll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSystemMediaSession);
} else {
  initSystemMediaSession();
}
