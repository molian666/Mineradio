'use strict';

const crypto = require('node:crypto');

const validationCache = new Map();

function urlFingerprint(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
}

function buildValidationCacheKey(candidate, expected) {
  return [candidate.sourceId || '', candidate.generation ?? '', candidate.songKey || '', expected.quality || candidate.quality || '', expected.expectedDurationSec ?? '', urlFingerprint(candidate.upstreamUrl)].join(':');
}

function ensureHttp(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('audio candidate URL must use HTTP or HTTPS'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('audio candidate URL must use HTTP or HTTPS');
  return parsed.toString();
}

function hasAudioMagic(magic) {
  if (!magic) return false;
  const value = Buffer.isBuffer(magic) ? magic : Buffer.from(String(magic), 'latin1');
  const text = value.toString('latin1', 0, 12);
  return text.startsWith('ID3') || text.startsWith('fLaC') || text.startsWith('OggS') || text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE' || value[0] === 0xff && (value[1] & 0xe0) === 0xe0;
}

function parseWavDuration(bytes, contentLength) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = null;
  while (offset + 8 <= bytes.length && offset < 4096) {
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ' && size >= 12 && body + 12 <= bytes.length) byteRate = bytes.readUInt32LE(body + 8);
    if (tag === 'data') dataSize = size === 0xffffffff ? null : size;
    offset = body + size + (size % 2);
    if (byteRate && dataSize != null) break;
  }
  if (!byteRate) return null;
  if (dataSize == null && Number.isFinite(contentLength)) dataSize = Math.max(0, contentLength - 44);
  return dataSize == null || dataSize <= 0 ? null : dataSize / byteRate;
}

function parseFlacDuration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 42 || bytes.toString('ascii', 0, 4) !== 'fLaC') return null;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const size = bytes.readUIntBE(offset + 1, 3);
    if ((header & 0x7f) === 0 && size >= 34 && offset + 4 + 34 <= bytes.length) {
      const body = offset + 4;
      const sampleRate = (bytes[body + 10] << 12) | (bytes[body + 11] << 4) | (bytes[body + 12] >> 4);
      const totalSamples = ((bytes[body + 13] & 0x0f) * 0x100000000) + bytes.readUInt32BE(body + 14);
      return sampleRate > 0 ? totalSamples / sampleRate : null;
    }
    offset += 4 + size;
    if (header & 0x80) break;
  }
  return null;
}

function parseMp3Duration(bytes, contentLength) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3' && bytes.length >= 10) {
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + tagSize + (bytes[5] & 0x10 ? 10 : 0);
  }
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const sampleRates = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
  for (let index = offset; index + 4 <= bytes.length && index < offset + 65536; index++) {
    const first = bytes[index];
    const second = bytes[index + 1];
    if (first !== 0xff || (second & 0xe0) !== 0xe0) continue;
    const version = (second >> 3) & 3;
    const layer = (second >> 1) & 3;
    const third = bytes[index + 2];
    const bitrateIndex = third >> 4;
    const sampleIndex = (third >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) continue;
    const versionIndex = version === 3 ? 0 : version === 2 ? 1 : 2;
    const sampleRate = sampleRates[versionIndex][sampleIndex];
    const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
    if (!sampleRate || !bitrate) continue;
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const sideInfo = version === 3 ? ((third & 1) ? 17 : 32) : ((third & 1) ? 9 : 17);
    const frameData = bytes.toString('ascii', index + 4 + sideInfo, index + 8 + sideInfo);
    if ((frameData === 'Xing' || frameData === 'Info') && index + 12 + sideInfo <= bytes.length) {
      const flags = bytes.readUInt32BE(index + 8 + sideInfo);
      if (flags & 1 && index + 16 + sideInfo <= bytes.length) {
        const frames = bytes.readUInt32BE(index + 12 + sideInfo);
        if (frames > 0) return frames * samplesPerFrame / sampleRate;
      }
    }
    if (Number.isFinite(contentLength) && contentLength > index) return (contentLength - index) * 8 / (bitrate * 1000);
  }
  return null;
}

function inferDurationSec(probe) {
  const explicit = Number(probe?.durationSec);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const bytes = Buffer.isBuffer(probe?.bytes) ? probe.bytes : null;
  const contentLength = Number(probe?.contentLength);
  if (!bytes) return null;
  return parseWavDuration(bytes, contentLength) || parseFlacDuration(bytes) || parseMp3Duration(bytes, contentLength) || null;
}

async function fetchProbe(url, signal) {
  const response = await fetch(url, { signal, headers: { Range: 'bytes=0-524287' } });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentLength = Number(response.headers.get('content-length')) || null;
  const contentRange = String(response.headers.get('content-range') || '');
  const rangeTotal = /\/([0-9]+)$/.exec(contentRange);
  return {
    statusCode: response.status,
    contentType: response.headers.get('content-type') || '',
    magic: buffer.subarray(0, 16),
    durationSec: Number(response.headers.get('x-audio-duration')) || null,
    contentLength: rangeTotal ? Number(rangeTotal[1]) : contentLength,
    bytes: buffer,
    endedEarly: false
  };
}

function resultFor(candidate, completeness, durationSec, reason, cacheKey) {
  return Object.freeze({
    upstreamUrl: candidate.upstreamUrl,
    proxyUrl: null,
    sourceKind: candidate.sourceKind || 'lx-user-api',
    completeness,
    sourceId: candidate.sourceId,
    generation: candidate.generation,
    durationSec: durationSec == null ? null : Number(durationSec),
    reason,
    cacheKey
  });
}

async function validateAudioCandidate(candidate, expected = {}) {
  if (!candidate || !candidate.upstreamUrl) throw new Error('audio candidate URL is required');
  const url = ensureHttp(candidate.upstreamUrl);
  const expectedDurationSec = Object.prototype.hasOwnProperty.call(expected, 'expectedDurationSec') ? expected.expectedDurationSec : candidate.expectedDurationSec;
  const cacheKey = buildValidationCacheKey({ ...candidate, upstreamUrl: url }, { ...expected, expectedDurationSec });
  const cached = validationCache.get(cacheKey);
  if (cached && cached.completeness === 'full') return cached;
  if (expectedDurationSec == null || !Number.isFinite(Number(expectedDurationSec)) || Number(expectedDurationSec) <= 0) {
    const result = resultFor(candidate, 'unknown', null, 'expected-duration-missing', cacheKey);
    return result;
  }
  if (expected.signal?.aborted || candidate.signal?.aborted) throw new Error('audio validation cancelled');
  const probe = candidate.probe || await fetchProbe(url, expected.signal || candidate.signal);
  if (expected.signal?.aborted || candidate.signal?.aborted) throw new Error('audio validation cancelled');
  const durationSec = inferDurationSec(probe);
  let result;
  if (probe.statusCode < 200 || probe.statusCode >= 300) result = resultFor(candidate, 'unknown', durationSec, 'http-status', cacheKey);
  else if (!String(probe.contentType || '').toLowerCase().startsWith('audio/') && !hasAudioMagic(probe.magic)) result = resultFor(candidate, 'unknown', durationSec, 'audio-format-unproven', cacheKey);
  else if (!hasAudioMagic(probe.magic)) result = resultFor(candidate, 'unknown', durationSec, 'audio-magic-unproven', cacheKey);
  else if (probe.endedEarly) result = resultFor(candidate, 'unknown', durationSec, 'ended-early', cacheKey);
  else if (durationSec == null) result = resultFor(candidate, 'unknown', null, 'duration-unproven', cacheKey);
  else if (durationSec + Math.max(2, Number(expectedDurationSec) * 0.03) < Number(expectedDurationSec)) result = resultFor(candidate, 'trial', durationSec, 'duration-shorter-than-song', cacheKey);
  else result = resultFor(candidate, 'full', durationSec, null, cacheKey);
  if (result.completeness === 'full') validationCache.set(cacheKey, result);
  return result;
}

function canPlayImported(result) {
  return Boolean(result && result.sourceKind === 'lx-user-api' && result.completeness === 'full');
}

function clearValidationCache() { validationCache.clear(); }

module.exports = { validateAudioCandidate, canPlayImported, clearValidationCache, buildValidationCacheKey };
