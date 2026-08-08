'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBoundedTtlCache,
  createByteBoundedCache,
} = require('../server/runtime-bounded-cache');

test('bounded TTL cache expires entries and evicts least recently used entries', () => {
  let now = 0;
  const cache = createBoundedTtlCache({ maxEntries: 2, ttlMs: 100, now: () => now });

  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);

  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  now = 101;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.size, 0);
});

test('byte bounded cache replaces a key without accumulating stale bytes', () => {
  const cache = createByteBoundedCache({
    maxBytes: 5,
    valueBytes: value => value.length,
  });

  cache.set('song', Buffer.alloc(4));
  assert.equal(cache.bytes, 4);

  cache.set('song', Buffer.alloc(2));
  assert.equal(cache.bytes, 2);

  cache.set('other', Buffer.alloc(4));
  assert.equal(cache.bytes, 4);
  assert.equal(cache.get('song'), undefined);
  assert.equal(cache.get('other').length, 4);
});

test('bounded cache supports explicit deletion and clearing', () => {
  const cache = createBoundedTtlCache({ maxEntries: 3, ttlMs: 1000, now: () => 0 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('missing'), false);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('b'), undefined);
});
