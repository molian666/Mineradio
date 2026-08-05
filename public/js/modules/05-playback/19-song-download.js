var downloadBusy = Object.create(null);

function songDownloadKey(song) {
  if (!song) return '';
  return String(song.providerSongId || song.id || song.mid || song.hash || song.name || song.title || 'song');
}

function songDownloadIsLocal(song) {
  return !!(song && (song.type === 'local' || song.source === 'local' || song.localUrl));
}

function songDownloadErrorText(result) {
  var code = String(result && (result.code || result.error) || 'DOWNLOAD_FAILED');
  if (code === 'DOWNLOAD_DIRECTORY_NOT_SELECTED') return '已取消选择下载目录';
  if (code === 'LOCAL_SONG_ALREADY_AVAILABLE') return '本地歌曲无需下载';
  if (code === 'DOWNLOAD_INVALID_URL') return '当前歌曲暂时没有可下载音源';
  if (code === 'DOWNLOAD_DIRECTORY_UNAVAILABLE') return '下载目录不可用，请在设置中重新选择';
  if (/HTTP|NETWORK|FETCH|BODY|WRITE/.test(code)) return '歌曲下载失败，请稍后重试';
  return '歌曲下载失败';
}

function downloadSong(song) {
  if (!song) {
    showToast('先播放或选择一首歌');
    return Promise.resolve({ ok: false, error: 'NO_SONG' });
  }
  if (songDownloadIsLocal(song)) {
    showToast('本地歌曲无需下载');
    return Promise.resolve({ ok: false, code: 'LOCAL_SONG_ALREADY_AVAILABLE', error: 'LOCAL_SONG_ALREADY_AVAILABLE' });
  }
  if (!window.desktopWindow || typeof window.desktopWindow.downloadSong !== 'function') {
    showToast('桌面版才支持下载歌曲');
    return Promise.resolve({ ok: false, code: 'DESKTOP_DOWNLOAD_UNAVAILABLE' });
  }
  var key = songDownloadKey(song);
  if (downloadBusy[key]) return Promise.resolve({ ok: false, code: 'DOWNLOAD_BUSY' });
  downloadBusy[key] = true;
  var provider = typeof songProviderKey === 'function' ? songProviderKey(song) : '';
  var requestedQuality = typeof getProviderPlaybackQuality === 'function'
    ? getProviderPlaybackQuality(provider)
    : '';
  var resolvePromise = typeof resolveAlbumGaplessPlaybackData === 'function'
    ? resolveAlbumGaplessPlaybackData(song, requestedQuality)
    : Promise.resolve(null);
  return Promise.resolve(resolvePromise)
    .then(function (data) {
      if (!data || !data.url) return { ok: false, code: 'DOWNLOAD_INVALID_URL', error: 'DOWNLOAD_INVALID_URL' };
      return window.desktopWindow.downloadSong({
        url: data.url,
        song: {
          id: song.id,
          providerSongId: song.providerSongId,
          artist: song.artist || '',
          name: song.name || song.title || '',
          type: song.type || '',
          source: song.source || '',
          localUrl: song.localUrl || '',
        },
      });
    })
    .then(function (result) {
      if (result && result.ok) showToast('已下载: ' + (result.filename || '歌曲文件'));
      else showToast(songDownloadErrorText(result));
      return result;
    })
    .catch(function (error) {
      var result = { ok: false, code: error && error.code || 'DOWNLOAD_FAILED', error: error && error.message || '' };
      showToast(songDownloadErrorText(result));
      return result;
    })
    .finally(function () {
      delete downloadBusy[key];
    });
}

function downloadCurrentSong() {
  return downloadSong(typeof currentCoverSong === 'function' ? currentCoverSong() : null);
}

function downloadSearchResult(index) {
  return downloadSong(Array.isArray(playlist) ? playlist[index] : null);
}

function downloadQueueIndex(index) {
  return downloadSong(Array.isArray(playQueue) ? playQueue[index] : null);
}

function downloadDetailSong(song) {
  return downloadSong(song);
}
