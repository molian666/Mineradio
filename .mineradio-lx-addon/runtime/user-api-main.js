'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createUserApiWindow } = require('./user-api-window');
const { normalizeSongForLx, resolveLxSourceResponse } = require('./source-adapter');
const { validateAudioCandidate, clearValidationCache } = require('./playback-integrity');

const EVENT_NAMES = Object.freeze({ inited: 'inited', request: 'request', updateAlert: 'updateAlert' });
const MAX_SOURCE_SIZE = 1024 * 1024;
const MAX_SOURCE_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20000;
let nextGeneration = 0;
const sessions = new Set();

function ensureSession(session) {
  if (!session || typeof session !== 'object') throw new Error('UserApi session is required');
  if (!session.controllers) session.controllers = new Set();
  if (session.disposed) throw new Error('UserApi session disposed');
  return session;
}

function diagnosticText(value, limit = 500) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function recordWindowDiagnostic(session, kind, detail) {
  const message = diagnosticText(detail);
  if (!message) return;
  session.lastWindowDiagnostic = `${kind}: ${message}`;
  console.warn('[UserApi]', {
    sourceId: session.sourceId,
    generation: session.generation,
    sourceLength: session.sourceLength,
    kind,
    detail: message
  });
}

function sourceExecutionError(session, error, phase) {
  const original = diagnosticText(error?.message || error || 'unknown error');
  const diagnostic = diagnosticText(session.lastWindowDiagnostic);
  const suffix = diagnostic && !original.includes(diagnostic) ? `; renderer diagnostic: ${diagnostic}` : '';
  const wrapped = new Error(`UserApi source ${phase} failed: ${original}${suffix}`);
  wrapped.code = 'USER_API_SOURCE_EXECUTION';
  wrapped.sourceId = session.sourceId;
  wrapped.generation = session.generation;
  wrapped.cause = error;
  return wrapped;
}

function attachWindowDiagnostics(session) {
  const webContents = session.window?.webContents;
  if (!webContents?.on) return;
  const consoleListener = (_event, level, message) => {
    const normalizedLevel = String(level || '').toLowerCase();
    if (normalizedLevel === 'error' || normalizedLevel === 'warning' || normalizedLevel === 'warn' || typeof level === 'number' && level >= 2) {
      recordWindowDiagnostic(session, 'console', message);
    }
  };
  const goneListener = (_event, details) => {
    const reason = details?.reason || 'unknown';
    const exitCode = details?.exitCode == null ? '' : ` (exitCode ${details.exitCode})`;
    recordWindowDiagnostic(session, 'render-process-gone', `${reason}${exitCode}`);
  };
  webContents.on('console-message', consoleListener);
  webContents.on('render-process-gone', goneListener);
  session.windowDiagnostics = [
    ['console-message', consoleListener],
    ['render-process-gone', goneListener],
  ];
}

function requestBody(options = {}) {
  const binary = value => Buffer.isBuffer(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : null;
  if (options.json != null) return { value: Buffer.from(JSON.stringify(options.json)), type: 'application/json' };
  if (options.binary != null) return { value: binary(options.binary) || Buffer.from(String(options.binary)), type: 'application/octet-stream' };
  if (options.xml != null) return { value: Buffer.from(String(options.xml)), type: 'application/xml' };
  if (options.text != null) return { value: Buffer.from(String(options.text)), type: 'text/plain' };
  if (options.body != null) {
    const value = binary(options.body);
    if (value) return { value, type: null };
    if (typeof options.body === 'object') return { value: Buffer.from(JSON.stringify(options.body)), type: 'application/json' };
    return { value: Buffer.from(String(options.body)), type: null };
  }
  if (options.form != null) {
    const input = options.form;
    const value = input instanceof URLSearchParams ? input.toString() : new URLSearchParams(Object.entries(input || {}).map(([key, item]) => [key, String(item)])).toString();
    return { value: Buffer.from(value), type: 'application/x-www-form-urlencoded' };
  }
  const formData = options.formdata ?? options.formData;
  if (formData != null) {
    const boundary = `----MineradioLxForm${crypto.randomBytes(8).toString('hex')}`;
    const parts = [];
    for (const [key, item] of Object.entries(formData || {})) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${item == null ? '' : String(item)}\r\n`);
    }
    parts.push(`--${boundary}--\r\n`);
    return { value: Buffer.from(parts.join('')), type: `multipart/form-data; boundary=${boundary}` };
  }
  return { value: null, type: null };
}

function decodeResponse(buffer, headers) {
  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
  if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
  if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer);
  return buffer;
}

function parseBody(raw, headers) {
  const text = raw.toString('utf8');
  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (contentType.includes('json') || /^\s*[\[{]/.test(text)) {
    try { return JSON.parse(text); } catch (_) { return text; }
  }
  return text;
}

function sourceContentTypeAllowed(headers) {
  const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType) return true;
  return contentType === 'text/plain' || contentType === 'text/javascript' || contentType === 'application/javascript' || contentType === 'application/x-javascript' || contentType === 'application/octet-stream';
}

function fetchUserApiSource(url, options = {}, redirectCount = 0) {
  let target;
  try { target = new URL(String(url || '')); } catch (_) { return Promise.reject(new Error('invalid UserApi source URL')); }
  if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new Error('UserApi source URL must use HTTP or HTTPS'));
  if (redirectCount > MAX_SOURCE_REDIRECTS) return Promise.reject(new Error('UserApi source URL redirected too many times'));
  const timeoutMs = Math.min(20000, Math.max(1, Number(options.timeoutMs) || 20000));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, { method: 'GET', headers: { accept: 'text/javascript, application/javascript, text/plain, application/octet-stream' } }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        finish(null, fetchUserApiSource(new URL(response.headers.location, target).toString(), options, redirectCount + 1));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_SOURCE_SIZE) {
          request.destroy(new Error('UserApi source response exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          finish(new Error(`UserApi source download failed with status ${status}`));
          return;
        }
        if (!sourceContentTypeAllowed(response.headers)) {
          finish(new Error('UserApi source URL did not return a text script'));
          return;
        }
        try {
          const raw = decodeResponse(Buffer.concat(chunks), response.headers);
          if (raw.length > MAX_SOURCE_SIZE) throw new Error('UserApi source response exceeds size limit');
          finish(null, raw.toString('utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
          finish(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('UserApi source download timeout')));
    request.on('error', error => finish(error));
    request.end();
  });
}

function readUserApiSourceFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('UserApi source file is required');
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute);
  if (raw.length > MAX_SOURCE_SIZE) throw new Error('UserApi source file exceeds size limit');
  return { name: path.basename(absolute), text: raw.toString('utf8').replace(/^\uFEFF/, '') };
}

function sourceNameFromUrl(url) {
  try {
    const target = new URL(url);
    const leaf = decodeURIComponent(target.pathname.split('/').filter(Boolean).pop() || '').replace(/\.js$/i, '').trim();
    return (leaf || target.hostname || 'UserApi 歌源').slice(0, 80);
  } catch (_) {
    return 'UserApi 歌源';
  }
}

function lxQualityFor(quality) {
  return ({ standard: '128k', exhigh: '320k', lossless: 'flac', hires: 'flac', jymaster: 'flac' })[quality] || '320k';
}

function sourceEntries(sources) {
  if (Array.isArray(sources)) return sources.map(source => typeof source === 'string' ? { source } : source).filter(Boolean);
  if (sources && typeof sources === 'object') return Object.entries(sources).map(([source, value]) => ({ source, ...(value && typeof value === 'object' ? value : {}) }));
  return [];
}

function normalizeLxProvider(provider) {
  const rawProvider = String(provider || '').trim().toLowerCase();
  return ({ netease: 'wy', qq: 'tx', kugou: 'kg', kuwo: 'kw', wy: 'wy', tx: 'tx', kg: 'kg', kw: 'kw' })[rawProvider] || null;
}

function pickSourceKey(song, sources) {
  const entries = sourceEntries(sources);
  const available = new Map(entries.map(entry => [entry.source, entry]));
  const mapped = normalizeLxProvider(song?.provider || song?.source);
  if (available.has(mapped)) return mapped;
  for (const key of ['wy', 'tx', 'kg']) if (available.has(key)) return key;
  return entries[0]?.source || null;
}

function durationForSong(song) {
  const value = song?.interval ?? song?.durationSec ?? (song?.duration_ms != null ? Number(song.duration_ms) / 1000 : undefined) ?? (song?.durationMs != null ? Number(song.durationMs) / 1000 : undefined) ?? song?.duration;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration > 10000 && song?.interval == null && song?.durationSec == null ? duration / 1000 : duration;
}

function comparableText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function artistText(song) {
  const value = song?.singer ?? song?.artist ?? song?.artists;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return value.name || '';
  return String(value || '');
}

function artistTokens(value) {
  return String(value == null ? '' : value)
    .split(/\s*(?:,|\/|&|、|;|\||\bfeat\.?\b|\bft\.?\b)\s*/iu)
    .map(comparableText)
    .filter(Boolean);
}

function artistsMatch(expected, candidate) {
  const expectedTokens = artistTokens(expected);
  const candidateTokens = new Set(artistTokens(candidate));
  return expectedTokens.length > 0 && expectedTokens.some(token => candidateTokens.has(token));
}

function kuwoQualityInfo(value) {
  const qualities = [];
  const details = {};
  for (const item of String(value || '').split(';')) {
    const match = /bitrate:(\d+)[^,;]*,format:[^,;]+,size:([^;]+)/i.exec(item);
    if (!match) continue;
    const type = ({ 4000: 'flac24bit', 2000: 'flac', 320: '320k', 128: '128k' })[match[1]];
    if (!type || details[type]) continue;
    qualities.push({ type, size: match[2] });
    details[type] = { size: match[2] };
  }
  return { types: qualities, _types: details };
}

function pickKuwoCandidate(song, payload) {
  const expectedName = comparableText(song?.name ?? song?.title);
  const expectedArtist = artistText(song);
  const expectedDuration = durationForSong(song);
  if (!expectedName) return null;
  let best = null;
  for (const item of Array.isArray(payload?.abslist) ? payload.abslist : []) {
    const id = String(item?.MUSICRID || item?.DC_TARGETID || '').replace(/^MUSIC_/i, '');
    const name = String(item?.SONGNAME || item?.NAME || '');
    const singer = String(item?.ARTIST || item?.FARTIST || '');
    if (!id || !name) continue;
    const candidateName = comparableText(name);
    const duration = Number(item?.DURATION);
    if (candidateName !== expectedName) continue;
    let score = 10;
    if (expectedArtist) {
      if (!artistsMatch(expectedArtist, singer)) continue;
      score += comparableText(singer) === comparableText(expectedArtist) ? 6 : 3;
    }
    if (expectedDuration && Number.isFinite(duration)) {
      const difference = Math.abs(duration - expectedDuration);
      if (difference <= 3) score += 4;
      else if (difference <= 8) score += 2;
      else if (difference > 20) continue;
    }
    if (score < 10 || best && best.score >= score) continue;
    const qualityInfo = kuwoQualityInfo(item.N_MINFO || item.MINFO);
    best = {
      score,
      song: {
        ...song,
        id,
        songId: id,
        songmid: id,
        strMediaMid: id,
        provider: 'kuwo',
        source: 'kw',
        name,
        singer,
        artist: singer,
        album: item.ALBUM || '',
        albumName: item.ALBUM || '',
        albumId: item.ALBUMID || '',
        interval: Number.isFinite(duration) ? duration : undefined,
        durationSec: Number.isFinite(duration) ? duration : undefined,
        ...qualityInfo,
        typeUrl: {}
      }
    };
  }
  return best?.song || null;
}

async function findKuwoCandidate(song, session, dependencies = {}) {
  const search = dependencies.searchKuwo || (async () => {
    const keywords = [song?.name ?? song?.title, artistText(song)].filter(Boolean).join(' ');
    const response = await requestUserApi({
      url: 'http://search.kuwo.cn/r.s',
      options: {
        timeout: 10000,
        query: {
          client: 'kt', all: keywords, pn: 0, rn: 8, uid: '794762570', ver: 'kwplayer_ar_9.2.2.1',
          vipver: 1, show_copyright_off: 1, newver: 1, ft: 'music', cluster: 0, strategy: 2012,
          encoding: 'utf8', rformat: 'json', vermerge: 1, mobi: 1, issubtitle: 1
        }
      },
      generation: session.generation
    }, session);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Kuwo search failed with status ${response.statusCode}`);
    return response.body;
  });
  return pickKuwoCandidate(song, await search(song));
}

function invokeSourceRequest(session, payload) {
  ensureSession(session);
  if (typeof session.requestHandler === 'function') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UserApi source request timeout')), REQUEST_TIMEOUT_MS);
      Promise.resolve().then(() => session.requestHandler(payload)).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  if (!session.window || session.window.isDestroyed?.() || !session.window.webContents?.send) throw new Error('UserApi source request handler is unavailable');
  const requestId = `${session.generation}:${++session.requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      reject(new Error('UserApi source request timeout'));
    }, REQUEST_TIMEOUT_MS);
    session.pendingRequests.set(requestId, { resolve, reject, timer });
    session.window.webContents.send('mineradio-lx-user-api-event', { event: EVENT_NAMES.request, payload, requestId });
  });
}

async function requestUserApiSongUrl(song, quality, session, options = {}, dependencies = {}) {
  ensureSession(session);
  const hasExplicitProvider = !!(options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'provider'));
  const forcedSourceKey = hasExplicitProvider ? normalizeLxProvider(options.provider) : null;
  if (hasExplicitProvider && !forcedSourceKey) {
    const error = new Error(`Unsupported UserApi provider: ${String(options.provider || '')}`);
    error.code = 'USER_API_PROVIDER_INVALID';
    throw error;
  }
  const sourceKey = hasExplicitProvider ? forcedSourceKey : pickSourceKey(song, session.inited?.sources);
  const source = sourceEntries(session.inited?.sources).find(entry => entry.source === sourceKey);
  if (!sourceKey || !source) {
    if (hasExplicitProvider) {
      const error = new Error(`Requested UserApi provider is unavailable: ${forcedSourceKey}`);
      error.code = 'USER_API_PROVIDER_UNAVAILABLE';
      throw error;
    }
    return null;
  }
  if (!Array.isArray(source.actions) || !source.actions.includes('musicUrl')) {
    if (hasExplicitProvider) {
      const error = new Error(`Requested UserApi provider does not support musicUrl: ${forcedSourceKey}`);
      error.code = 'USER_API_PROVIDER_UNAVAILABLE';
      throw error;
    }
    return null;
  }
  const requestedQuality = lxQualityFor(quality);
  const sourceQuality = Array.isArray(source.qualitys) && source.qualitys.includes(requestedQuality)
    ? requestedQuality
    : source.qualitys?.[0] || requestedQuality;
  const qualityAttempts = [sourceQuality];
  const fallbackQualities = sourceQuality === 'flac'
    ? ['320k', '128k']
    : sourceQuality === '320k' ? ['128k'] : [];
  for (const fallbackQuality of fallbackQualities) {
    if (Array.isArray(source.qualitys) && source.qualitys.includes(fallbackQuality)) qualityAttempts.push(fallbackQuality);
  }
  const musicInfo = normalizeSongForLx(song, sourceKey, quality);
  const expectedDurationSec = durationForSong(song);
  let lastError;
  for (const attemptQuality of qualityAttempts) {
    try {
      const response = await invokeSourceRequest(session, {
        source: sourceKey,
        action: 'musicUrl',
        info: { type: attemptQuality, musicInfo }
      });
      const resolved = await resolveLxSourceResponse(response, {
        request: (url, options) => requestUserApi({ url, options, generation: session.generation }, session)
      });
      const candidate = {
        ...resolved,
        upstreamUrl: resolved.url,
        sourceId: session.sourceId,
        generation: session.generation,
        songKey: String(song?.songKey || song?.id || song?.songId || song?.mid || song?.songmid || `${song?.name || ''}:${song?.artist || ''}`),
        expectedDurationSec,
        quality
      };
      const validation = await validateAudioCandidate(candidate, { expectedDurationSec, quality });
      if (validation.completeness !== 'full') {
        const error = new Error(`imported audio rejected: ${validation.completeness}`);
        error.code = 'USER_API_AUDIO_INCOMPLETE';
        error.result = validation;
        throw error;
      }
      return { ...validation, url: validation.upstreamUrl, level: attemptQuality, sourceKind: 'lx-user-api' };
    } catch (error) {
      lastError = error;
    }
  }
  const kuwoSource = sourceEntries(session.inited?.sources).find(entry => entry.source === 'kw');
  if (sourceKey !== 'kw' && options.kuwoFallback !== false && Array.isArray(kuwoSource?.actions) && kuwoSource.actions.includes('musicUrl')) {
    try {
      const kuwoCandidate = await findKuwoCandidate(song, session, dependencies);
      if (kuwoCandidate) {
        return await requestUserApiSongUrl(kuwoCandidate, quality, session, { provider: 'kw', kuwoFallback: false }, dependencies);
      }
    } catch (error) {
      if (!lastError) lastError = error;
    }
  }
  throw lastError || new Error('UserApi source did not return a playable URL');
}

function requestUserApi(request, session, redirectCount = 0) {
  const current = ensureSession(session);
  const generation = request.generation == null ? current.generation : request.generation;
  if (generation !== current.generation) return Promise.reject(new Error('stale generation'));
  const options = request.options || {};
  let target;
  try {
    target = new URL(request.url);
    if (options.query && typeof options.query === 'object') {
      for (const [key, value] of Object.entries(options.query)) {
        if (value != null) target.searchParams.set(key, String(value));
      }
    }
  } catch (_) { return Promise.reject(new Error('invalid UserApi URL')); }
  if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new Error('UserApi URL must use HTTP or HTTPS'));
  const maxRedirects = Math.max(0, Math.min(10, Number(options.maxRedirect ?? options.follow_max) || 5));
  const body = requestBody(options);
  const headers = { ...(options.headers || {}) };
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36';
  if (body.type && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = body.type;
  if (body.value && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) headers['content-length'] = body.value.length;
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate, br';
  const timeoutMs = Math.min(60000, Math.max(1, Number(options.timeout ?? options.timeoutMs) || 60000));
  let cancelRequest = () => {};
  const promise = new Promise((resolve, reject) => {
    const controller = new AbortController();
    cancelRequest = () => controller.abort();
    current.controllers.add(controller);
    const requestId = request.requestId == null ? null : String(request.requestId);
    if (requestId) current.requestControllers?.set(requestId, controller);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method: String(options.method || 'GET').toUpperCase(), headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const nextUrl = new URL(response.headers.location, target).toString();
        response.resume();
        if (redirectCount >= maxRedirects) {
          reject(new Error('UserApi request redirected too many times'));
        } else {
          response.once('end', () => requestUserApi({ ...request, url: nextUrl }, session, redirectCount + 1).then(resolve, reject));
        }
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > 16 * 1024 * 1024) req.destroy(new Error('response exceeds size limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (current.disposed) throw new Error('UserApi session disposed');
          if (generation !== current.generation) throw new Error('stale generation');
          const rawBytes = decodeResponse(Buffer.concat(chunks), response.headers);
          const result = {
            statusCode: response.statusCode || 0,
            status: response.statusCode || 0,
            statusMessage: response.statusMessage || '',
            headers: response.headers,
            bytes: rawBytes.length,
            raw: rawBytes,
            rawBody: rawBytes,
            body: parseBody(rawBytes, response.headers)
          };
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('UserApi request timeout')));
    req.on('error', error => {
      const detail = `${target.toString()} ${String(options.method || 'GET').toUpperCase()}: ${error.code || error.message || error}`;
      console.warn('[UserApiRequest] failed:', detail);
      reject(error.message === 'aborted' ? new Error('UserApi request cancelled') : error);
    });
    const cancel = () => req.destroy(new Error('UserApi request cancelled'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    if (body.value) req.write(body.value);
    req.end();
    req.on('close', () => {
      current.controllers.delete(controller);
      if (requestId && current.requestControllers?.get(requestId) === controller) current.requestControllers.delete(requestId);
    });
  });
  promise.cancel = cancelRequest;
  if (typeof request.callback === 'function') promise.then(value => request.callback(null, value), error => request.callback(error));
  return promise;
}

function createLXBridge(session) {
  const listeners = new Map();
  const send = (event, payload) => {
    if (!Object.values(EVENT_NAMES).includes(event)) return Promise.reject(new Error(`The event is not supported: ${event}`));
    if (payload && typeof payload === 'object') {
      try { payload = JSON.parse(JSON.stringify(payload)); } catch (_) { payload = { value: String(payload) }; }
    }
    if (event === EVENT_NAMES.inited) { session.inited = payload; if (session.resolveInited) session.resolveInited(payload); }
    for (const listener of listeners.get(event) || []) listener(payload);
    return Promise.resolve();
  };
  const on = (event, listener) => {
    if (!Object.values(EVENT_NAMES).includes(event)) return Promise.reject(new Error(`The event is not supported: ${event}`));
    if (typeof listener !== 'function') return Promise.reject(new Error('LX event handler must be a function'));
    if (event === EVENT_NAMES.request) session.requestHandler = listener;
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(listener);
    return Promise.resolve();
  };
  const request = (url, options, callback) => {
    const promise = requestUserApi({ url, options, callback: null }, session);
    if (typeof callback === 'function') promise.then(value => callback(null, value, value.body), error => callback(error, null, null));
    return () => promise.cancel?.();
  };
  const aesEncrypt = (buffer, mode, key, iv) => {
    const keyBuffer = Buffer.from(key || '');
    const requestedMode = String(mode || 'cbc').toLowerCase();
    const algorithm = /^aes-\d+-[a-z0-9-]+$/.test(requestedMode) ? requestedMode : `aes-${keyBuffer.length * 8}-${requestedMode}`;
    const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv == null ? null : Buffer.from(iv));
    return Buffer.concat([cipher.update(Buffer.from(buffer || '')), cipher.final()]);
  };
  return {
    version: '2.0.0',
    env: 'desktop',
    currentScriptInfo: session.currentScriptInfo,
    EVENT_NAMES,
    request,
    send,
    on,
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
}

async function loadUserApiSource(sourceText, sourceId, options = {}) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('source text is required');
  if (Buffer.byteLength(sourceText, 'utf8') > 1024 * 1024) throw new Error('source text exceeds size limit');
  if (typeof options.BrowserWindow !== 'function') throw new Error('BrowserWindow is required for UserApi source execution');
  if (typeof options.ipcMain?.on !== 'function') throw new Error('ipcMain.on is required for UserApi source execution');
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const session = { sourceId, generation: ++nextGeneration, sourceLength: Buffer.byteLength(sourceText, 'utf8'), currentScriptInfo: { name: metadata.name || sourceId, version: metadata.version || '', author: metadata.author || '', description: metadata.description || '', homepage: metadata.homepage || '', rawScript: sourceText }, controllers: new Set(), requestControllers: new Map(), disposed: false, inited: null, window: null, requestHandler: null, pendingRequests: new Map(), requestSequence: 0, ipcListeners: [], windowDiagnostics: [], lastWindowDiagnostic: '', ipcMain: options.ipcMain };
  sessions.add(session);
  if (typeof options.onSession === 'function') options.onSession(session);
  const inited = new Promise(resolve => { session.resolveInited = resolve; });
  session.window = createUserApiWindow(options);
  attachWindowDiagnostics(session);
  {
      const eventListener = (event, message) => {
        if (event.sender !== session.window.webContents || !message) return;
        if (message.event === EVENT_NAMES.inited) {
          session.inited = message.payload;
          if (session.resolveInited) session.resolveInited(message.payload);
        }
      };
      const responseListener = (event, message) => {
        if (event.sender !== session.window.webContents || !message?.requestId) return;
        const pending = session.pendingRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.pendingRequests.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      };
      const scriptInfoListener = event => {
        if (event.sender !== session.window.webContents) return;
        event.returnValue = { ...session.currentScriptInfo };
      };
      options.ipcMain.on('mineradio-lx-user-api-event', eventListener);
      options.ipcMain.on('mineradio-lx-user-api-response', responseListener);
      options.ipcMain.on('mineradio-lx-user-api-script-info', scriptInfoListener);
      session.ipcListeners.push(
        ['mineradio-lx-user-api-event', eventListener],
        ['mineradio-lx-user-api-response', responseListener],
        ['mineradio-lx-user-api-script-info', scriptInfoListener]
      );
  }
  try {
    await session.window.loadURL(options.url || 'about:blank');
  } catch (error) {
    const wrapped = sourceExecutionError(session, error, 'window load');
    await disposeUserApiSession(session);
    throw wrapped;
  }
  try {
    await session.window.webContents.executeJavaScript(sourceText);
  } catch (error) {
    const wrapped = sourceExecutionError(session, error, 'execution');
    await disposeUserApiSession(session);
    throw wrapped;
  }
  const resolvedInited = session.inited || await Promise.race([inited, new Promise(resolve => setTimeout(() => resolve({ sources: [] }), 5000))]);
  session.inited = resolvedInited;
  return { sourceId, generation: session.generation, inited: resolvedInited, session };
}

async function disposeUserApiSession(session) {
  if (!session || session.disposed) return;
  session.disposed = true;
  for (const controller of session.controllers || []) controller.abort();
  session.controllers?.clear();
  session.requestControllers?.clear?.();
  for (const pending of session.pendingRequests?.values?.() || []) {
    clearTimeout(pending.timer);
    pending.reject(new Error('UserApi session disposed'));
  }
  session.pendingRequests?.clear?.();
  for (const [channel, listener] of session.ipcListeners || []) session.ipcMain?.removeListener?.(channel, listener);
  for (const [event, listener] of session.windowDiagnostics || []) session.window?.webContents?.removeListener?.(event, listener);
  if (session.window && typeof session.window.destroy === 'function' && !session.window.isDestroyed?.()) session.window.destroy();
  sessions.delete(session);
}

function resolveUserApiStorePath(app) {
  const appData = app?.getPath?.('appData');
  if (!appData) return null;
  const canonical = path.join(appData, 'Mineradio-LX', 'userData', 'user-api-sources.json');
  if (fs.existsSync(canonical)) return canonical;
  const legacyPaths = [
    path.join(appData, 'Mineradio-LX', 'cache', 'Mineradio-LX', 'userData', 'user-api-sources.json'),
    app?.getPath?.('userData') ? path.join(app.getPath('userData'), 'user-api-sources.json') : null
  ].filter(file => file && path.resolve(file) !== path.resolve(canonical));
  const legacy = legacyPaths.find(file => fs.existsSync(file));
  if (!legacy) return canonical;
  try {
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.copyFileSync(legacy, canonical, fs.constants.COPYFILE_EXCL);
    return canonical;
  } catch (_) {
    return legacy;
  }
}

function registerUserApiIpc({ ipcMain, BrowserWindow, app, dialog, store, preloadPath } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('ipcMain.handle is required');
  const stateStore = store || require('./user-api-store').createUserApiStore({
    filePath: resolveUserApiStorePath(app)
  });
  let activeSession = null;
  let lifecycleQueue = Promise.resolve();
  let explicitActivationRequested = false;
  let disposed = false;
  const enqueueLifecycle = operation => {
    const pending = lifecycleQueue.then(operation, operation);
    lifecycleQueue = pending.catch(() => {});
    return pending;
  };
  const loadActiveSource = async source => {
    if (disposed) throw new Error('UserApi runtime disposed');
    if (activeSession) await disposeUserApiSession(activeSession);
    activeSession = null;
    let loadingSession = null;
    try {
      const loaded = await loadUserApiSource(source.sourceText, source.sourceId, {
        BrowserWindow,
        ipcMain,
        preloadPath,
        userData: app?.getPath?.('userData'),
        metadata: source.metadata,
        onSession: session => { loadingSession = session; }
      });
      activeSession = loaded.session;
      return loaded;
    } catch (error) {
      await disposeUserApiSession(loadingSession);
      throw error;
    }
  };
  ipcMain.handle('mineradio-lx-user-api-add', (_event, sourceText, metadata) => stateStore.addSource(sourceText, metadata));
  ipcMain.handle('mineradio-lx-user-api-pick-file', async event => {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') throw new Error('UserApi file picker is unavailable');
    const owner = BrowserWindow?.fromWebContents?.(event.sender) || BrowserWindow?.getFocusedWindow?.();
    const result = await dialog.showOpenDialog(owner, {
      title: '选择 UserApi 歌源脚本',
      properties: ['openFile'],
      filters: [{ name: 'JavaScript', extensions: ['js'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    try { return { ok: true, ...readUserApiSourceFile(result.filePaths[0]) }; }
    catch (error) { return { ok: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('mineradio-lx-user-api-import-url', async (_event, url) => {
    const sourceText = await fetchUserApiSource(url);
    return stateStore.addSource(sourceText, { name: sourceNameFromUrl(String(url || '')) });
  });
  ipcMain.handle('mineradio-lx-user-api-activate', async (_event, sourceId) => {
    explicitActivationRequested = true;
    clearValidationCache();
    return enqueueLifecycle(async () => {
      const source = await stateStore.activateSource(sourceId);
      const loaded = await loadActiveSource(source);
      return { sourceId: loaded.sourceId, generation: loaded.generation, inited: loaded.inited };
    });
  });
  ipcMain.handle('mineradio-lx-user-api-remove', async (_event, sourceId) => {
    explicitActivationRequested = true;
    clearValidationCache();
    return enqueueLifecycle(async () => {
      if (activeSession?.sourceId === sourceId) {
        await disposeUserApiSession(activeSession);
        activeSession = null;
      }
      return stateStore.removeSource(sourceId);
    });
  });
  ipcMain.handle('mineradio-lx-user-api-request', (_event, request) => { if (!activeSession) throw new Error('no active UserApi source'); return requestUserApi(request, activeSession); });
  ipcMain.handle('mineradio-lx-user-api-cancel', (_event, requestId) => {
    const controller = activeSession?.requestControllers?.get?.(String(requestId));
    if (controller) controller.abort();
    return Boolean(controller);
  });
  ipcMain.handle('mineradio-lx-user-api-resolve-song-url', (_event, song, quality, options) => { if (!activeSession) throw new Error('no active UserApi source'); return requestUserApiSongUrl(song, quality, activeSession, options); });
  ipcMain.handle('mineradio-lx-user-api-providers', () => require('./source-adapter').getAvailableLxProviders(activeSession?.inited?.sources || []));
  ipcMain.handle('mineradio-lx-user-api-state', () => stateStore.getState());
  if (typeof app?.whenReady === 'function') {
    void app.whenReady().then(async () => {
      if (explicitActivationRequested) return;
      const source = stateStore.getActiveSource?.();
      if (!source) return;
      await enqueueLifecycle(async () => {
        if (explicitActivationRequested) return;
        try {
          await loadActiveSource(source);
        } catch (error) {
          console.error('[UserApi] restore active source failed:', error.message || String(error));
        }
      });
      });
  }
  return {
    channels: ['mineradio-lx-user-api-add', 'mineradio-lx-user-api-pick-file', 'mineradio-lx-user-api-import-url', 'mineradio-lx-user-api-activate', 'mineradio-lx-user-api-remove', 'mineradio-lx-user-api-resolve-song-url', 'mineradio-lx-user-api-state'],
    dispose: () => enqueueLifecycle(async () => {
      if (disposed) return;
      disposed = true;
      explicitActivationRequested = true;
      clearValidationCache();
      if (activeSession) await disposeUserApiSession(activeSession);
      activeSession = null;
    })
  };
}

module.exports = { loadUserApiSource, requestUserApi, requestUserApiSongUrl, invokeSourceRequest, disposeUserApiSession, registerUserApiIpc, fetchUserApiSource, readUserApiSourceFile, resolveUserApiStorePath, EVENT_NAMES };
