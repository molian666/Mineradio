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

test('UserApi diagnostics use Electron\'s object console-message event shape', () => {
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  assert.match(runtime, /const consoleListener = \(_event, details\) =>/);
});

test('restored UserApi sources can request during script initialization', async () => {
  const ipcMain = createIpcMain();
  let initializationError = null;
  let requestObserved = false;
  let activeSourceRead = false;
  let windowCreated = false;
  let loadUrlCalled = false;
  let executeCalled = false;
  let windowDestroyed = false;
  const webContents = {
    on() {},
    removeListener() {},
    send() {},
    isDestroyed() { return windowDestroyed; },
    async executeJavaScript() {
      executeCalled = true;
      const initedListener = ipcMain.listeners.get('mineradio-lx-user-api-event');
      initedListener?.({ sender: webContents }, { event: 'inited', payload: { sources: [] } });
      const requestHandler = ipcMain.handlers.get('mineradio-lx-user-api-request');
      try {
        const request = requestHandler({}, {
          url: 'not-a-url',
          options: { timeout: 1 },
          requestId: 'init-request'
        });
        requestObserved = true;
        request?.catch(() => {});
      } catch (error) {
        initializationError = error;
      }
    }
  };
  const BrowserWindow = function FakeBrowserWindow() {
    windowCreated = true;
    return {
      webContents,
      async loadURL() { loadUrlCalled = true; },
      isDestroyed() { return windowDestroyed; },
      destroy() { windowDestroyed = true; }
    };
  };
  const runtime = registerUserApiIpc({
    ipcMain,
    BrowserWindow,
    app: {
      getPath() { return path.dirname(runtimePath); },
      whenReady() { return Promise.resolve(); },
    },
    store: {
      getActiveSource() {
        activeSourceRead = true;
        return { sourceId: 'restored-source', sourceText: 'void 0;', metadata: {} };
      }
    },
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeSourceRead, true);
  assert.equal(windowCreated, true);
  assert.equal(loadUrlCalled, true);
  assert.equal(executeCalled, true);
  assert.equal(initializationError, null);
  assert.equal(requestObserved, true);
  await runtime.dispose();
});
