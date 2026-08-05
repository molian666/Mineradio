function setMineradioDownloadStorageText(value) {
  var node = document.getElementById('download-storage-root');
  if (node) node.textContent = value == null || value === '' ? '尚未选择下载目录' : String(value);
}

function applyMineradioDownloadSettings(result) {
  if (!result || result.ok !== true) {
    setMineradioDownloadStorageText('读取下载目录失败');
    return;
  }
  var settings = result.settings || {};
  setMineradioDownloadStorageText(settings.downloadPath || '尚未选择下载目录');
}

function refreshMineradioDownloadSettings() {
  if (!window.desktopWindow || typeof window.desktopWindow.getDownloadSettings !== 'function') {
    setMineradioDownloadStorageText('仅桌面版支持歌曲下载');
    return Promise.resolve();
  }
  return window.desktopWindow.getDownloadSettings()
    .then(applyMineradioDownloadSettings)
    .catch(function () { setMineradioDownloadStorageText('读取下载目录失败'); });
}

function chooseMineradioDownloadRoot() {
  if (!window.desktopWindow || typeof window.desktopWindow.chooseDownloadDirectory !== 'function') return;
  return window.desktopWindow.chooseDownloadDirectory()
    .then(function (choice) {
      if (!choice || !choice.ok || choice.canceled) return choice;
      var selectedPath = choice.settings && choice.settings.downloadPath;
      if (selectedPath && typeof window.desktopWindow.setDownloadDirectory === 'function') {
        return window.desktopWindow.setDownloadDirectory(selectedPath);
      }
      return choice;
    })
    .then(function (result) {
      if (result && result.ok) applyMineradioDownloadSettings(result);
      return result;
    })
    .catch(function () {
      setMineradioDownloadStorageText('保存下载目录失败');
    });
}

setTimeout(refreshMineradioDownloadSettings, 500);
