'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createKugouLoginSessionGate } = require('../desktop/kugou-login-session');

const mainSource = fs.readFileSync(path.resolve(__dirname, '../desktop/main.js'), 'utf8');

test('unchanged rejected Kugou cookie is validated once', async () => {
  let calls = 0;
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async () => {
      calls += 1;
      return {
        validated: false,
        reauthRequired: true,
        providerErrorCode: 20017,
        error: 'KUGOU_SESSION_REJECTED',
      };
    },
  });

  const first = await gate.inspect('userid=1; token=old');
  const second = await gate.inspect('userid=1; token=old');

  assert.equal(first.attempted, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
});

test('changed Kugou cookie can validate and becomes reusable', async () => {
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async value => ({
      validated: value.includes('fresh'),
      reauthRequired: false,
      providerErrorCode: 0,
      error: '',
    }),
  });

  await gate.inspect('userid=1; token=old');
  const fresh = await gate.inspect('userid=1; token=fresh');

  assert.equal(fresh.validated, true);
  assert.equal(gate.isValidated('userid=1; token=fresh'), true);
  assert.equal(gate.isValidated('userid=1; token=old'), false);
});

test('unrelated Kugou cookie changes do not repeat session validation', async () => {
  let calls = 0;
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async () => {
      calls += 1;
      return { validated: true, reauthRequired: false, providerErrorCode: 0, error: '' };
    },
  });

  const first = await gate.inspect('userid=1; token=fresh; tracking=one');
  const second = await gate.inspect('tracking=two; token=fresh; userid=1');

  assert.equal(first.validated, true);
  assert.equal(second.validated, true);
  assert.equal(second.duplicate, true);
  assert.equal(gate.isValidated('userid=1; token=fresh; tracking=three'), true);
  assert.equal(calls, 1);
});

test('incomplete Kugou cookie does not call the session validator', async () => {
  let calls = 0;
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async () => {
      calls += 1;
      return { validated: true };
    },
  });

  const missingIdentity = await gate.inspect('token=fresh');
  const missingPlayback = await gate.inspect('userid=1');

  assert.equal(missingIdentity.attempted, false);
  assert.equal(missingIdentity.identityPresent, false);
  assert.equal(missingPlayback.attempted, false);
  assert.equal(missingPlayback.playbackFieldsPresent, false);
  assert.equal(calls, 0);
});

test('concurrent checks for one Kugou cookie share the in-flight validation', async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const gate = createKugouLoginSessionGate({
    hasLogin: () => true,
    hasPlayback: () => true,
    validateSession: async () => {
      calls += 1;
      await pending;
      return { validated: true, reauthRequired: false, providerErrorCode: 0, error: '' };
    },
  });

  const first = gate.inspect('userid=1; token=fresh');
  const second = gate.inspect('userid=1; token=fresh');
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.validated, true);
  assert.equal(secondResult.validated, true);
  assert.equal(secondResult.duplicate, true);
  assert.equal(calls, 1);
});

test('superseded Kugou cookie validation cannot become successful', async () => {
  const releases = new Map();
  const gate = createKugouLoginSessionGate({
    hasLogin: () => true,
    hasPlayback: () => true,
    validateSession: cookie => new Promise(resolve => releases.set(cookie, resolve)),
  });

  const oldInspection = gate.inspect('userid=1; token=old');
  await Promise.resolve();
  const newInspection = gate.inspect('userid=1; token=fresh');
  await Promise.resolve();
  releases.get('userid=1; token=fresh')({
    validated: false,
    reauthRequired: true,
    providerErrorCode: 20017,
    error: 'KUGOU_SESSION_REJECTED',
  });
  await newInspection;
  releases.get('userid=1; token=old')({
    validated: true,
    reauthRequired: false,
    providerErrorCode: 0,
    error: '',
  });

  const staleResult = await oldInspection;
  assert.equal(staleResult.validated, false);
  assert.equal(gate.isValidated('userid=1; token=old'), false);
});

test('reset invalidates an in-flight Kugou session validation', async () => {
  let release;
  const gate = createKugouLoginSessionGate({
    hasLogin: () => true,
    hasPlayback: () => true,
    validateSession: () => new Promise(resolve => { release = resolve; }),
  });

  const inspection = gate.inspect('userid=1; token=fresh');
  await Promise.resolve();
  gate.reset();
  release({ validated: true, reauthRequired: false, providerErrorCode: 0, error: '' });

  assert.equal((await inspection).validated, false);
  assert.equal(gate.isValidated('userid=1; token=fresh'), false);
});

test('Kugou login window cannot bypass server playlist-session validation', () => {
  assert.match(mainSource, /createKugouLoginSessionGate/);
  assert.match(mainSource, /await kugouSessionGate\.inspect\(initialCookie\)/);
  assert.doesNotMatch(mainSource, /if \(kugouCookieHasPlayback\(initialCookie\)\) return \{ ok: true/);
  assert.doesNotMatch(mainSource, /resolve\(kugouCookieHasPlayback\(cookie\)/);
  assert.match(mainSource, /inspection\.validated\s*&&\s*kugouSessionGate\.isValidated\(cookie\)/);
  assert.match(
    mainSource,
    /loginWindow\.on\('closed',[\s\S]{0,300}settled = true;\s*kugouSessionGate\.reset\(\);[\s\S]{0,200}await readKugouLoginCookieHeader/
  );
  assert.doesNotMatch(
    mainSource,
    /\[KugouPlaylistSync\]\[login\] session-validation[\s\S]{0,500}error:\s*inspection\.error/
  );
});
