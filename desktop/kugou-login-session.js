'use strict';

const crypto = require('node:crypto');

const KUGOU_SESSION_COOKIE_NAMES = new Set([
  'kugoo',
  'kugou',
  'token',
  't',
  'userid',
  'kugooid',
  'kugouid',
  'kg_mid',
  'kugou_api_mid',
  'mid',
  'kg_dfid',
  'dfid',
]);

function cookieFingerprintSource(cookie) {
  const cookieText = String(cookie || '');
  const sessionParts = [];
  cookieText.split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator <= 0) return;
    const name = part.slice(0, separator).trim().toLowerCase();
    if (!KUGOU_SESSION_COOKIE_NAMES.has(name)) return;
    sessionParts.push(`${name}=${part.slice(separator + 1).trim()}`);
  });
  return sessionParts.length ? sessionParts.sort().join('\n') : cookieText;
}

function cookieFingerprint(cookie) {
  return crypto.createHash('sha256').update(cookieFingerprintSource(cookie), 'utf8').digest('hex');
}

function baseInspection(identityPresent, playbackFieldsPresent) {
  return {
    identityPresent,
    playbackFieldsPresent,
    attempted: false,
    duplicate: false,
    validated: false,
    reauthRequired: false,
    providerErrorCode: 0,
    error: '',
  };
}

function normalizeValidationResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    validated: value.validated === true,
    reauthRequired: value.reauthRequired === true,
    providerErrorCode: Math.max(0, Number(value.providerErrorCode) || 0),
    error: String(value.error || ''),
  };
}

function createKugouLoginSessionGate(options) {
  const hasLogin = options && options.hasLogin;
  const hasPlayback = options && options.hasPlayback;
  const validateSession = options && options.validateSession;
  if (typeof hasLogin !== 'function' || typeof hasPlayback !== 'function' || typeof validateSession !== 'function') {
    throw new TypeError('Kugou login session gate requires cookie checks and a session validator');
  }

  let generation = 0;
  let latestInspectionId = 0;
  let lastCompleted = null;
  let validatedFingerprint = '';
  const inFlight = new Map();

  async function inspect(cookie) {
    const cookieText = String(cookie || '');
    const identityPresent = hasLogin(cookieText) === true;
    const playbackFieldsPresent = hasPlayback(cookieText) === true;
    const base = baseInspection(identityPresent, playbackFieldsPresent);
    if (!identityPresent || !playbackFieldsPresent) return base;

    const fingerprint = cookieFingerprint(cookieText);
    if (lastCompleted && lastCompleted.fingerprint === fingerprint) {
      return Object.assign({}, lastCompleted.result, { duplicate: true });
    }

    const existing = inFlight.get(fingerprint);
    if (existing && existing.generation === generation) {
      return existing.promise.then(result => Object.assign({}, result, { duplicate: true }));
    }

    const inspectionGeneration = generation;
    const inspectionId = ++latestInspectionId;
    const promise = Promise.resolve()
      .then(() => validateSession(cookieText))
      .then(normalizeValidationResult, error => normalizeValidationResult({
        error: error && error.message || 'KUGOU_PLAYLIST_VALIDATION_FAILED',
      }))
      .then(validation => {
        const result = Object.assign({}, base, validation, { attempted: true });
        const isCurrent = inspectionGeneration === generation && inspectionId === latestInspectionId;
        if (!isCurrent) {
          return Object.assign({}, result, {
            validated: false,
            reauthRequired: false,
            providerErrorCode: 0,
            error: 'KUGOU_PLAYLIST_VALIDATION_SUPERSEDED',
          });
        }
        lastCompleted = { fingerprint, result };
        validatedFingerprint = result.validated ? fingerprint : '';
        return result;
      })
      .finally(() => {
        const current = inFlight.get(fingerprint);
        if (current && current.promise === promise) inFlight.delete(fingerprint);
      });

    inFlight.set(fingerprint, { generation: inspectionGeneration, promise });
    return promise;
  }

  function isValidated(cookie) {
    return !!validatedFingerprint && cookieFingerprint(cookie) === validatedFingerprint;
  }

  function reset() {
    generation += 1;
    latestInspectionId = 0;
    lastCompleted = null;
    validatedFingerprint = '';
    inFlight.clear();
  }

  return { inspect, isValidated, reset };
}

module.exports = { createKugouLoginSessionGate };
