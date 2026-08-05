'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const EVENT_NAMES = Object.freeze({ inited: 'inited', request: 'request', updateAlert: 'updateAlert' });
let requestSequence = 0;
let initedSent = false;
let updateAlertSent = false;

function currentScriptInfo() {
  const info = ipcRenderer.sendSync('mineradio-lx-user-api-script-info');
  if (!info || typeof info !== 'object') return { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' };
  return {
    name: String(info.name || ''),
    description: String(info.description || ''),
    version: String(info.version || ''),
    author: String(info.author || ''),
    homepage: String(info.homepage || ''),
    rawScript: typeof info.rawScript === 'string' ? info.rawScript : ''
  };
}

function aesEncrypt(buffer, mode, key, iv) {
  const keyBuffer = Buffer.from(key || '');
  const requestedMode = String(mode || 'cbc').toLowerCase();
  const algorithm = /^aes-\d+-[a-z0-9-]+$/.test(requestedMode) ? requestedMode : `aes-${keyBuffer.length * 8}-${requestedMode}`;
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv == null ? null : Buffer.from(iv));
  return Buffer.concat([cipher.update(Buffer.from(buffer || '')), cipher.final()]);
}

function sourceRequest(url, options, callback) {
  const requestId = `source:${++requestSequence}`;
  const promise = ipcRenderer.invoke('mineradio-lx-user-api-request', { url, options, requestId }).then(value => {
    if (!value || typeof value !== 'object') {
      console.warn('[UserApiRequest] response', url, 'non-object');
      return value;
    }
    const normalizeBytes = bytes => {
      if (bytes == null || Buffer.isBuffer(bytes)) return bytes;
      if (bytes.type === 'Buffer' && Array.isArray(bytes.data)) return Buffer.from(bytes.data);
      return Buffer.from(bytes);
    };
    const normalized = { ...value, raw: normalizeBytes(value.raw), rawBody: normalizeBytes(value.rawBody) };
    const body = normalized.body;
    const summary = body && typeof body === 'object' ? Object.keys(body).slice(0, 12).join(',') : `${typeof body}:${String(body).slice(0, 80)}`;
    console.warn('[UserApiRequest] response', url, `status=${normalized.statusCode}`, `body=${summary}`);
    return normalized;
  });
  if (typeof callback === 'function') promise.then(value => callback(null, value, value.body), error => {
    console.error('[UserApiRequest] source request failed:', url, error?.stack || error?.message || String(error));
    callback(error, null, null);
  });
  return () => { void ipcRenderer.invoke('mineradio-lx-user-api-cancel', requestId).catch(() => {}); };
}

const api = {
  version: '2.0.0',
  env: 'desktop',
  currentScriptInfo: currentScriptInfo(),
  EVENT_NAMES,
  request(url, options, callback) {
    return sourceRequest(url, options, callback);
  },
  send(event, payload) {
    if (!Object.values(EVENT_NAMES).includes(event)) return Promise.reject(new Error(`The event is not supported: ${event}`));
    if (event === EVENT_NAMES.inited) {
      if (initedSent) return Promise.reject(new Error('Script is inited'));
      initedSent = true;
    }
    if (event === EVENT_NAMES.updateAlert) {
      if (updateAlertSent) return Promise.reject(new Error('The update alert can only be called once.'));
      updateAlertSent = true;
    }
    ipcRenderer.send('mineradio-lx-user-api-event', { event, payload });
    return Promise.resolve();
  },
  on(event, handler) {
    if (!Object.values(EVENT_NAMES).includes(event)) return Promise.reject(new Error(`The event is not supported: ${event}`));
    if (event !== EVENT_NAMES.request || typeof handler !== 'function') return Promise.reject(new Error('The request event handler must be a function'));
    const listener = (_event, message) => {
      if (message?.event !== event) return;
      Promise.resolve().then(() => handler(message.payload)).then(result => {
        if (message.requestId) ipcRenderer.send('mineradio-lx-user-api-response', { requestId: message.requestId, result });
      }, error => {
        if (message.requestId) ipcRenderer.send('mineradio-lx-user-api-response', { requestId: message.requestId, error: error?.stack || error?.message || String(error) });
      });
    };
    ipcRenderer.on('mineradio-lx-user-api-event', listener);
    return Promise.resolve(() => ipcRenderer.removeListener('mineradio-lx-user-api-event', listener));
  },
  utils: {
    crypto: {
      aesEncrypt,
      rsaEncrypt: (buffer, key) => {
        const input = Buffer.from(buffer || '');
        const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - input.length)), input]);
        return crypto.publicEncrypt({ key: String(key || ''), padding: crypto.constants.RSA_NO_PADDING }, padded);
      },
      randomBytes: size => crypto.randomBytes(Math.max(0, Number(size) || 0)),
      md5: value => crypto.createHash('md5').update(value == null ? '' : value).digest('hex'),
      sha256: value => crypto.createHash('sha256').update(value == null ? '' : value).digest('hex')
    },
    buffer: {
      from: (...args) => Buffer.from(...args),
      bufToString: (value, encoding) => Buffer.from(value || '', 'binary').toString(encoding || 'utf8'),
      toString: value => Buffer.from(value).toString('base64')
    },
    zlib: {
      inflate: value => new Promise((resolve, reject) => zlib.inflate(Buffer.from(value || ''), (error, output) => error ? reject(error) : resolve(output))),
      deflate: value => new Promise((resolve, reject) => zlib.deflate(Buffer.from(value || ''), (error, output) => error ? reject(error) : resolve(output))),
      gunzip: value => zlib.gunzipSync(Buffer.from(value || ''))
    }
  }
};

contextBridge.exposeInMainWorld('lx', api);
