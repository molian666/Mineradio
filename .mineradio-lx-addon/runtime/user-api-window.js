'use strict';

function createUserApiWindow({ BrowserWindow, preloadPath, userData } = {}) {
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
      partition: userData ? `persist:mineradio-lx-${userData}` : undefined
    }
  });
}

module.exports = { createUserApiWindow };
