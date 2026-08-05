const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimePath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-main.js');
const { registerUserApiIpc } = require(runtimePath);

function createIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on(channel, listener) { this.listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
    },
  };
}

test('registerUserApiIpc exposes a shutdown promise for the hidden UserApi session', async () => {
  const ipcMain = createIpcMain();
  const runtime = registerUserApiIpc({
    ipcMain,
    BrowserWindow: function BrowserWindow() {},
    app: {
      getPath() { return path.dirname(runtimePath); },
      whenReady() { return Promise.resolve(); },
    },
    store: { getActiveSource() { return null; } },
  });

  assert.equal(typeof runtime.dispose, 'function');
  await runtime.dispose();
});

test('desktop shutdown awaits UserApi disposal', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  assert.match(main, /userApiRuntime\.dispose\(\)/);
  assert.match(main, /await userApiRuntime\.dispose\(\)/);
});
