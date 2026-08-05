const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainText = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

function beforeQuitBlock() {
  const start = mainText.indexOf("app.on('before-quit'");
  assert.ok(start >= 0, 'missing before-quit handler');
  const end = mainText.indexOf("\n  });", start);
  assert.ok(end > start, 'missing before-quit handler terminator');
  return mainText.slice(start, end);
}

test('shutdown waits for owned resources and force-exits after cleanup', () => {
  const block = beforeQuitBlock();

  assert.match(block, /stopDesktopLyricsMousePoller\(\)/);
  assert.match(block, /await closeLocalServer\(\)/);
  assert.match(block, /destroyAllWindowsForQuit\(\)/);
  assert.match(block, /app\.exit\(0\)/);
});

test('shutdown has a short Windows process-tree fallback for stuck cleanup', () => {
  assert.match(mainText, /function forceTerminateOwnedProcessTree\(\)/);
  assert.match(mainText, /taskkill\.exe/);
  assert.match(mainText, /MINERADIO_SHUTDOWN_HARD_TIMEOUT_MS/);
});

test('explicit exit requests enter app quit instead of the tray close path', () => {
  const start = mainText.indexOf("ipcMain.handle('desktop-window-close'");
  assert.ok(start >= 0, 'missing desktop close IPC handler');
  const end = mainText.indexOf("ipcMain.handle('desktop-window-get-close-behavior'", start);
  assert.ok(end > start, 'missing desktop close IPC handler terminator');
  const block = mainText.slice(start, end);

  assert.match(block, /appQuitting\s*=\s*true/);
  assert.match(block, /app\.quit\(\)/);
});
