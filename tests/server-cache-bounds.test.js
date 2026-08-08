'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverText = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const packageText = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');

test('server uses bounded cache primitives for long-lived provider caches', () => {
  assert.match(serverText, /require\(['"]\.\/server\/runtime-bounded-cache['"]\)/);
  assert.match(packageText, /"server\/runtime-bounded-cache\.js"/);
  assert.match(serverText, /createBoundedTtlCache\(/);
  assert.match(serverText, /createByteBoundedCache\(/);
  assert.doesNotMatch(serverText, /const qishuiAudioDecryptCache = new Map\(\)/);
  assert.doesNotMatch(serverText, /const qqLikedPlaylistCoverByUser = new Map\(\)/);
  assert.doesNotMatch(serverText, /const neteaseSourceMatchCache = new Map\(\)/);
  assert.doesNotMatch(serverText, /const qqVipInfoCache = new Map\(\)/);
});

test('qishui audio cache no longer keeps a separate stale byte counter', () => {
  assert.match(serverText, /maxBytes:\s*QISHUI_AUDIO_DECRYPT_CACHE_MAX_BYTES/);
  assert.doesNotMatch(serverText, /qishuiAudioDecryptCacheBytes\s*\+=/);
  assert.doesNotMatch(serverText, /qishuiAudioDecryptCacheBytes\s*-=/);
});

test('source-match cache keeps explicit positive and negative TTL policy', () => {
  assert.match(serverText, /NETEASE_SOURCE_MATCH_POSITIVE_TTL_MS/);
  assert.match(serverText, /NETEASE_SOURCE_MATCH_NEGATIVE_TTL_MS/);
  assert.match(serverText, /neteaseSourceMatchCache\.set\(key, \{ at: Date\.now\(\), candidates: normalized \}, ttlMs\);/);
});
