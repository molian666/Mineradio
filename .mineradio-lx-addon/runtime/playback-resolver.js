'use strict';

const { validateAudioCandidate, canPlayImported } = require('./playback-integrity');

const scopes = new Map();
let requestId = 0;

function songKeyFor(song) {
  return String(song?.songKey || song?.id || song?.songId || song?.mid || song?.songmid || `${song?.name || ''}:${song?.artist || ''}`);
}

function nativeResult(result) {
  if (!result || typeof result !== 'object') throw new Error('native resolver returned no result');
  return {
    upstreamUrl: result.upstreamUrl || result.url || '',
    proxyUrl: result.proxyUrl || null,
    sourceKind: 'native',
    completeness: result.completeness || (result.trial ? 'trial' : 'full'),
    sourceId: result.sourceId || 'native',
    generation: result.generation || 0,
    durationSec: result.durationSec ?? null,
    ...(result.reason ? { reason: result.reason } : {})
  };
}

function cancelResolution(scopeId) {
  const transaction = scopes.get(scopeId);
  if (!transaction) return false;
  transaction.cancelled = true;
  transaction.controller.abort();
  scopes.delete(scopeId);
  return true;
}

async function resolvePlayback(song, options = {}) {
  const scopeId = options.scopeId || songKeyFor(song);
  cancelResolution(scopeId);
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const transaction = { scopeId, sourceId: null, generation: null, songKey: songKeyFor(song), quality: options.quality || 'standard', requestId: ++requestId, controller, cancelled: false };
  scopes.set(scopeId, transaction);
  const isCurrent = () => scopes.get(scopeId) === transaction && !transaction.cancelled && !controller.signal.aborted;
  const fallback = async reason => {
    if (!isCurrent()) throw new Error('resolution cancelled');
    const result = nativeResult(await options.nativeResolver(song, options.quality || 'standard'));
    if (!isCurrent()) throw new Error('resolution cancelled');
    const final = reason ? { ...result, reason } : result;
    if (song && typeof song === 'object') song.playbackResolution = final;
    return final;
  };
  try {
    let imported = options.imported;
    if (typeof options.importedResolver === 'function') imported = await options.importedResolver(song, { quality: options.quality || 'standard', signal: controller.signal });
    if (!isCurrent()) throw new Error('resolution cancelled');
    if (imported) {
      const candidate = { ...imported, sourceKind: 'lx-user-api', songKey: imported.songKey || transaction.songKey, expectedDurationSec: imported.expectedDurationSec ?? song?.durationSec ?? song?.duration, signal: controller.signal };
      transaction.sourceId = candidate.sourceId;
      transaction.generation = candidate.generation;
      const validation = await validateAudioCandidate(candidate, { expectedDurationSec: candidate.expectedDurationSec, quality: options.quality || 'standard', signal: controller.signal });
      if (!isCurrent()) throw new Error('resolution cancelled');
      if (canPlayImported(validation)) {
        if (song && typeof song === 'object') song.playbackResolution = validation;
        return validation;
      }
      return await fallback(validation.reason || validation.completeness);
    }
    return await fallback('no-imported-source');
  } catch (error) {
    if (!isCurrent() || error?.message === 'resolution cancelled' || error?.message === 'audio validation cancelled' || error?.message === 'cancelled') throw new Error('resolution cancelled');
    return await fallback(error.message || 'imported-source-failed');
  } finally {
    if (scopes.get(scopeId) === transaction) scopes.delete(scopeId);
  }
}

module.exports = { resolvePlayback, cancelResolution };
