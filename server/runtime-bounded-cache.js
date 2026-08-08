'use strict';

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function createBoundedTtlCache(options = {}) {
  const maxEntries = Math.max(0, Math.floor(finiteNonNegative(options.maxEntries, 128)));
  const defaultTtlMs = finiteNonNegative(options.ttlMs, 0);
  const readNow = typeof options.now === 'function' ? options.now : Date.now;
  const entries = new Map();

  function now() {
    const value = Number(readNow());
    return Number.isFinite(value) ? value : Date.now();
  }

  function removeExpired() {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > 0 && entry.expiresAt <= current) entries.delete(key);
    }
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlMs) {
    entries.delete(key);
    if (maxEntries === 0) return value;
    const ttl = finiteNonNegative(ttlMs, defaultTtlMs);
    entries.set(key, {
      value,
      expiresAt: ttl > 0 ? now() + ttl : 0,
    });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  }

  function has(key) {
    return get(key) !== undefined;
  }

  return {
    get,
    set,
    has,
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      removeExpired();
      return entries.size;
    },
  };
}

function createByteBoundedCache(options = {}) {
  const maxBytes = Math.max(0, Math.floor(finiteNonNegative(options.maxBytes, 0)));
  const valueBytes = typeof options.valueBytes === 'function'
    ? options.valueBytes
    : value => value && value.length || 0;
  const readNow = typeof options.now === 'function' ? options.now : Date.now;
  const defaultTtlMs = finiteNonNegative(options.ttlMs, 0);
  const entries = new Map();
  let bytes = 0;

  function now() {
    const value = Number(readNow());
    return Number.isFinite(value) ? value : Date.now();
  }

  function entryBytes(value) {
    const size = Number(valueBytes(value));
    return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  }

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes = Math.max(0, bytes - entry.bytes);
    return true;
  }

  function removeExpired() {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > 0 && entry.expiresAt <= current) remove(key);
    }
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && entry.expiresAt <= now()) {
      remove(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlMs) {
    remove(key);
    const size = entryBytes(value);
    if (maxBytes === 0 || size === 0) return value;
    const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 0
      ? Number(ttlMs)
      : defaultTtlMs;
    entries.set(key, {
      value,
      bytes: size,
      expiresAt: ttl > 0 ? now() + ttl : 0,
    });
    bytes += size;
    while (bytes > maxBytes && entries.size > 1) remove(entries.keys().next().value);
    return value;
  }

  return {
    get,
    set,
    has(key) {
      return get(key) !== undefined;
    },
    delete: remove,
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      removeExpired();
      return entries.size;
    },
    get bytes() {
      removeExpired();
      return bytes;
    },
  };
}

module.exports = {
  createBoundedTtlCache,
  createByteBoundedCache,
};
