'use strict';

const PROVIDERS = Object.freeze(['netease', 'kugou', 'qq']);
const UNKNOWN_PROVIDER = 'unknown';
const UNKNOWN_CANDIDATE_IDENTITY = '__unknown_source_identity__';
const SOURCE_TO_PROVIDER = Object.freeze({
  wy: 'netease',
  tx: 'qq',
  kg: 'kugou'
});
const PROVIDER_TO_SOURCE = Object.freeze({
  netease: 'wy',
  qq: 'tx',
  kugou: 'kg'
});

function providerKeyForSong(song = {}) {
  const raw = String(song.provider ?? song.source ?? '').trim().toLowerCase();
  return SOURCE_TO_PROVIDER[raw] || (PROVIDERS.includes(raw) ? raw : UNKNOWN_PROVIDER);
}

function remainingProviders(originalProvider) {
  const current = providerKeyForSong({ provider: originalProvider });
  if (current === UNKNOWN_PROVIDER) return [...PROVIDERS];
  return PROVIDERS.filter(provider => provider !== current);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function candidateSongForProvider(song = {}, provider, matchedSong = {}) {
  const normalizedProvider = providerKeyForSong({ provider });
  const candidate = { ...song, provider: normalizedProvider, source: PROVIDER_TO_SOURCE[normalizedProvider] };
  const songId = firstDefined(
    matchedSong.songId,
    matchedSong.id,
    song.songId,
    song.id
  );
  const songmid = firstDefined(
    matchedSong.songmid,
    matchedSong.strMediaMid,
    song.songmid,
    song.strMediaMid,
    songId
  );
  const strMediaMid = firstDefined(
    matchedSong.strMediaMid,
    matchedSong.songmid,
    song.strMediaMid,
    song.songmid,
    songId
  );
  const hash = firstDefined(matchedSong.hash, song.hash);
  const albumId = firstDefined(matchedSong.albumId, song.albumId);
  const duration = firstDefined(matchedSong.duration, matchedSong.interval, song.duration, song.interval);

  if (songmid !== undefined) candidate.songmid = songmid;
  if (strMediaMid !== undefined) candidate.strMediaMid = strMediaMid;
  if (songId !== undefined) candidate.songId = songId;
  if (hash !== undefined) candidate.hash = hash;
  if (albumId !== undefined) candidate.albumId = albumId;
  if (duration !== undefined) candidate.duration = duration;

  return candidate;
}

function candidateKey(candidate = {}) {
  const provider = providerKeyForSong(candidate);
  const identity = firstDefined(
    candidate.songmid,
    candidate.strMediaMid,
    candidate.songId,
    candidate.hash,
    candidate.albumId
  );
  return `${provider}:${String(identity ?? UNKNOWN_CANDIDATE_IDENTITY)}`;
}

function lxProviderKeyForProvider(provider) {
  return PROVIDER_TO_SOURCE[providerKeyForSong({ provider })];
}

function hasPlayableUrl(result) {
  return !!(result && typeof result === 'object' && (result.url || result.upstreamUrl));
}

async function resolveImportedWithCandidates(song, quality, dependencies = {}) {
  if (typeof dependencies.resolve !== 'function') return null;
  const originalProvider = providerKeyForSong(song);
  const originalLxProviderKey = lxProviderKeyForProvider(originalProvider);
  try {
    const original = await dependencies.resolve(song, quality, { provider: originalLxProviderKey });
    if (hasPlayableUrl(original)) return original;
  } catch (error) {
    if (typeof dependencies.warn === 'function') dependencies.warn(error);
  }

  const providers = remainingProviders(originalProvider);
  const matches = new Map();
  for (const provider of providers) {
    try {
      if (typeof dependencies.search !== 'function') continue;
      const matched = dependencies.search.length >= 2
        ? await dependencies.search(song, provider)
        : await dependencies.search(provider, song);
      if (matched) matches.set(provider, matched);
    } catch (error) {
      if (typeof dependencies.warn === 'function') dependencies.warn(error);
    }
  }

  for (const provider of providers) {
    const matched = matches.get(provider);
    if (!matched) continue;
    const candidate = candidateSongForProvider(song, provider, matched);
    const lxProviderKey = lxProviderKeyForProvider(provider);
    try {
      const result = await dependencies.resolve(candidate, quality, { provider: lxProviderKey });
      if (hasPlayableUrl(result)) return result;
    } catch (error) {
      if (typeof dependencies.warn === 'function') dependencies.warn(error);
    }
  }
  return null;
}

module.exports = {
  providerKeyForSong,
  remainingProviders,
  candidateSongForProvider,
  candidateKey,
  lxProviderKeyForProvider,
  resolveImportedWithCandidates
};
