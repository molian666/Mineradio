'use strict';

const { resolvePlayback } = require('./playback-resolver');
const { validateAudioCandidate, canPlayImported } = require('./playback-integrity');

async function resolveEntry(songOrCandidate, options = {}) {
  if (songOrCandidate?.upstreamUrl && songOrCandidate?.sourceKind === 'lx-user-api' && !options.imported && !options.importedResolver && typeof options.nativeResolver !== 'function') {
    const result = await validateAudioCandidate(songOrCandidate, { expectedDurationSec: songOrCandidate.expectedDurationSec, quality: options.quality, signal: options.signal });
    if (!canPlayImported(result)) throw new Error(`${result.completeness}: ${result.reason || 'imported candidate rejected'}`);
    return result;
  }
  return resolvePlayback(songOrCandidate, options);
}

function resolveForMainPlayback(song, options) { return resolveEntry(song, options); }
function resolveForPreload(song, options) { return resolveEntry(song, options); }
function resolveForFallback(song, options) { return resolveEntry(song, options); }
function resolveForPrefetch(song, options) { return resolveEntry(song, { ...options, allowPrefetch: true }); }

module.exports = { resolveForMainPlayback, resolveForPreload, resolveForFallback, resolveForPrefetch };
