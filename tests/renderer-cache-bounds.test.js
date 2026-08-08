'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const renderPowerText = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '00-state', '08-desktop-render-power.js'),
  'utf8',
);
const sourceTexts = [
  'public/js/modules/04-shelf/04-cover-api-helpers.js',
  'public/js/modules/03-beat/04-beat-map-runtime.js',
  'public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js',
  'public/js/modules/03-beat/02-podcast-dj-analysis.js',
  'public/js/modules/05-playback/18-cuefield-automix-integration.js',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));

test('renderer caches expose one bounded access-order insertion helper', () => {
  assert.match(renderPowerText, /function rememberRuntimeCacheEntry\(/);
  assert.match(renderPowerText, /RUNTIME_RENDER_CACHE_LIMITS/);
  assert.match(renderPowerText, /loading/);
  assert.match(sourceTexts[0], /rememberRuntimeCacheEntry\(\s*playlistCoverCache/);
  assert.match(sourceTexts[1] + sourceTexts[2], /rememberRuntimeCacheEntry\(beatMapCache/);
  assert.match(sourceTexts[3], /rememberRuntimeCacheEntry\(djBeatMapCache/);
  assert.match(sourceTexts[4], /rememberRuntimeCacheEntry\(cuefieldAudioDescriptorCache/);
});

test('runtime cache helper preserves protected entries while bounding completed values', () => {
  assert.match(renderPowerText, /protectedKeys/);
  assert.match(renderPowerText, /candidateValue\.loading/);
  assert.match(renderPowerText, /delete cache\[evictedKey\]/);
  assert.match(renderPowerText, /cacheCounts/);
});
