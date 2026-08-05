'use strict';

const crypto = require('node:crypto');

const PROVIDER_MAP = Object.freeze({
  kw: { provider: 'kuwo', label: '酷我' },
  wy: { provider: 'netease', label: '网易云' },
  tx: { provider: 'qq', label: 'QQ 音乐' },
  kg: { provider: 'kugou', label: '酷狗' }
});

function durationFor(song) {
  const value = song.interval ?? song.durationSec ?? (song.duration_ms != null ? Number(song.duration_ms) / 1000 : undefined) ?? (song.durationMs != null ? Number(song.durationMs) / 1000 : undefined) ?? song.duration;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 10000 && song.interval == null && song.durationSec == null ? number / 1000 : number;
}

function normalizeSongForLx(song = {}, nativeProvider, quality = 'standard') {
  const duration = durationFor(song);
  const songId = song.songId ?? song.id ?? undefined;
  const mediaId = song.songmid ?? song.mediaMid ?? song.mid ?? songId;
  const result = {
    songmid: mediaId,
    strMediaMid: song.strMediaMid ?? song.mediaMid ?? song.mid ?? songId,
    songId,
    hash: song.hash ?? song.fileHash ?? song.audioHash ?? (nativeProvider === 'wy' ? songId : undefined),
    albumId: song.albumId ?? song.album_id ?? undefined,
    albumMid: song.albumMid ?? song.album_mid ?? undefined,
    copyrightId: song.copyrightId ?? song.copyright_id ?? undefined,
    name: song.name ?? song.title ?? undefined,
    artist: song.artist ?? undefined,
    singer: song.singer ?? song.artists ?? undefined,
    album: song.album ?? undefined,
    img: song.cover ?? song.pic ?? song.image ?? undefined,
    interval: song.interval ?? duration ?? undefined,
    duration: duration ?? undefined,
    quality,
    source: nativeProvider
  };
  const types = song.types ?? song._types;
  if (types != null) {
    result.types = types;
    result._types = song._types ?? types;
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

function sourceEntries(initedSources) {
  const values = Array.isArray(initedSources) ? initedSources : (initedSources && (initedSources.sources || initedSources));
  if (Array.isArray(values)) return values.map(value => typeof value === 'string' ? { source: value } : value).filter(Boolean);
  if (values && typeof values === 'object') return Object.entries(values).map(([source, value]) => ({ source, ...(value && typeof value === 'object' ? value : {}) }));
  return [];
}

function getAvailableLxProviders(initedSources) {
  return sourceEntries(initedSources)
    .filter(item => PROVIDER_MAP[item.source] && item.enabled !== false)
    .map(item => ({ source: item.source, provider: PROVIDER_MAP[item.source].provider, label: PROVIDER_MAP[item.source].label, enabled: true }));
}

function getPath(value, expression) {
  if (Array.isArray(expression)) return expression.reduce((current, key) => current?.[key], value);
  return String(expression || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function parseSerialized(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { throw new Error('invalid aggregate data'); }
  }
  return value;
}

function ensureHttp(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('LX source URL must use HTTP or HTTPS'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LX source URL must use HTTP or HTTPS');
  return url.toString();
}

async function resolveLxSourceResponse(response, context = {}) {
  const payload = response?.body && typeof response.body === 'object' ? response.body : response;
  const direct = typeof response === 'string' ? response : payload?.url || response?.url;
  if (direct) return { url: ensureHttp(direct), sourceKind: 'lx-user-api' };
  if (Number(payload?.code) !== 303) throw new Error('LX source response has no playable URL');
  const serialized = payload?.B?.data ?? payload?.data ?? response?.B?.data;
  const aggregate = parseSerialized(serialized);
  const descriptor = aggregate?.D || aggregate?.B?.D;
  const finalSpec = aggregate?.F || aggregate?.B?.F;
  if (!descriptor?.url || !finalSpec?.url || typeof context.request !== 'function') throw new Error('invalid 303 aggregate response');
  const second = await context.request(descriptor.url, descriptor.options || {});
  const secondBody = second?.body ?? second;
  const check = finalSpec.check;
  if (check && getPath(secondBody, check.key) !== check.value) throw new Error('303 aggregate check failed');
  const finalUrl = getPath(secondBody, finalSpec.url);
  return { url: ensureHttp(finalUrl), sourceKind: 'lx-user-api' };
}

function createSourceId(sourceText) {
  return crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
}

module.exports = { normalizeSongForLx, getAvailableLxProviders, resolveLxSourceResponse, createSourceId };
