# Kugou Playlist Session Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent field-complete but provider-rejected Kugou web cookies from being reported as playlist-sync ready, and complete login only after the cloud-playlist service accepts the session.

**Architecture:** `kugou-api.js` owns the provider request and converts provider failures into a credential-safe validation contract. A focused `desktop/kugou-login-session.js` gate deduplicates validation by cookie fingerprint, while `desktop/main.js` uses that gate to decide whether to reuse, clear, continue, or finish the official login window. Existing renderer catalog transactions remain unchanged and preserve successful rows on all validation failures.

**Tech Stack:** Node.js CommonJS, Electron, Node built-in test runner.

## Global Constraints

- Preserve unrelated user changes in the dirty worktree.
- Add no dependencies.
- Never log raw Cookie, Token, user ID, MID, DFID, or a reusable cookie fingerprint.
- Treat provider code `20017` as requiring reauthentication.
- Keep network and unknown provider failures retryable and non-destructive.
- Do not add a speculative alternate Kugou playlist endpoint.

---

### Task 1: Backend playlist-session validation contract

**Files:**
- Modify: `kugou-api.js:776-797, 1756-1817, 2540-2581`
- Modify: `tests/kugou-playlist-sync-resilience.test.js`

**Interfaces:**
- Produces: `kugouGatewayProviderErrorCode(error) -> number`
- Produces: `classifyKugouPlaylistSessionFailure(auth, error) -> { validated, playlistReady, reauthRequired, providerErrorCode, error }`
- Produces: `validateKugouPlaylistSession(cookie) -> Promise<{ provider, loggedIn, playbackReady, validated, playlistReady, reauthRequired, providerErrorCode, error }>`
- `handleKugouUserPlaylists(cookie)` preserves `providerErrorCode` and `reauthRequired` in failure responses.

- [ ] **Step 1: Add failing classification tests**

Add literal expectations to `tests/kugou-playlist-sync-resilience.test.js`:

```js
test('Kugou provider code 20017 requires playlist-session reauthentication', () => {
  const classify = kugouApi._test.classifyKugouPlaylistSessionFailure;
  const result = classify(
    { loggedIn: true, playbackReady: true },
    { message: 'KUGOU_GATEWAY_FAILED', body: { status: 0, error_code: 20017 } }
  );
  assert.deepEqual(result, {
    validated: false,
    playlistReady: false,
    reauthRequired: true,
    providerErrorCode: 20017,
    error: 'KUGOU_SESSION_REJECTED',
  });
});

test('Kugou transport failures stay retryable without forcing reauthentication', () => {
  const classify = kugouApi._test.classifyKugouPlaylistSessionFailure;
  const result = classify(
    { loggedIn: true, playbackReady: true },
    new Error('ETIMEDOUT')
  );
  assert.equal(result.reauthRequired, false);
  assert.equal(result.providerErrorCode, 0);
  assert.equal(result.error, 'ETIMEDOUT');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/kugou-playlist-sync-resilience.test.js`

Expected: FAIL because `classifyKugouPlaylistSessionFailure` is undefined.

- [ ] **Step 3: Implement the provider error classifier and shared catalog request**

Add the minimal helpers in `kugou-api.js`:

```js
function kugouGatewayProviderErrorCode(error) {
  const body = error && error.body;
  return Math.max(0, Number(body && (body.error_code != null ? body.error_code : body.code)) || 0);
}

function classifyKugouPlaylistSessionFailure(auth, error) {
  const providerErrorCode = kugouGatewayProviderErrorCode(error);
  const reauthRequired = providerErrorCode === 20017;
  return {
    validated: false,
    playlistReady: false,
    reauthRequired,
    providerErrorCode,
    error: reauthRequired ? 'KUGOU_SESSION_REJECTED' : String(error && error.message || 'KUGOU_PLAYLIST_FAILED'),
  };
}
```

Extract the current `/v7/get_all_list` call into `requestKugouUserPlaylistCatalog(cookie, auth, pageSize)`. Implement `validateKugouPlaylistSession(cookie)` using that request and the classifier. Export the validator publicly and the pure classifier through `_test`.

- [ ] **Step 4: Preserve structured failure data in user playlists**

In `handleKugouUserPlaylists`, use `classifyKugouPlaylistSessionFailure(auth, err)` in the catch branch and return:

```js
{
  provider: 'kugou',
  loggedIn: true,
  playbackReady: auth.playbackReady,
  playlists: [],
  error: failure.error,
  providerErrorCode: failure.providerErrorCode,
  reauthRequired: failure.reauthRequired,
  message: failure.reauthRequired ? '酷狗会话已失效，请重新登录' : '酷狗歌单加载失败，请稍后重试',
}
```

Add only `providerErrorCode` and `reauthRequired` to the safe backend failure log.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test tests/kugou-playlist-sync-resilience.test.js`

Expected: all tests pass.

---

### Task 2: Deduplicated Electron login-session gate

**Files:**
- Create: `desktop/kugou-login-session.js`
- Create: `tests/kugou-login-session-gate.test.js`

**Interfaces:**
- Produces: `createKugouLoginSessionGate({ hasLogin, hasPlayback, validateSession })`
- Gate method: `inspect(cookie) -> Promise<{ identityPresent, playbackFieldsPresent, attempted, duplicate, validated, reauthRequired, providerErrorCode, error }>`
- Gate method: `isValidated(cookie) -> boolean`
- Gate method: `reset() -> void`

- [ ] **Step 1: Write failing gate behavior tests**

Create `tests/kugou-login-session-gate.test.js` with these real behavior cases:

```js
test('unchanged rejected Kugou cookie is validated once', async () => {
  let calls = 0;
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async () => {
      calls += 1;
      return { validated: false, reauthRequired: true, providerErrorCode: 20017, error: 'KUGOU_SESSION_REJECTED' };
    },
  });
  const first = await gate.inspect('userid=1; token=old');
  const second = await gate.inspect('userid=1; token=old');
  assert.equal(first.attempted, true);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
});

test('changed Kugou cookie can validate and becomes reusable', async () => {
  const gate = createKugouLoginSessionGate({
    hasLogin: value => value.includes('userid='),
    hasPlayback: value => value.includes('token='),
    validateSession: async value => ({ validated: value.includes('fresh'), reauthRequired: false, providerErrorCode: 0, error: '' }),
  });
  await gate.inspect('userid=1; token=old');
  const fresh = await gate.inspect('userid=1; token=fresh');
  assert.equal(fresh.validated, true);
  assert.equal(gate.isValidated('userid=1; token=fresh'), true);
  assert.equal(gate.isValidated('userid=1; token=old'), false);
});
```

Also test that missing identity/playback fields do not call `validateSession`.

- [ ] **Step 2: Run the gate test and verify RED**

Run: `node --test tests/kugou-login-session-gate.test.js`

Expected: FAIL because `desktop/kugou-login-session.js` does not exist.

- [ ] **Step 3: Implement the minimal gate**

Use `crypto.createHash('sha256')` internally to compare cookie values without exposing them. Cache the last completed inspection and share one in-flight promise for the same fingerprint. Return only booleans, provider error code, and safe error text; never return the fingerprint.

- [ ] **Step 4: Run the gate test and verify GREEN**

Run: `node --test tests/kugou-login-session-gate.test.js`

Expected: all gate tests pass.

---

### Task 3: Wire validation into the official Kugou login window

**Files:**
- Modify: `desktop/main.js:25, 2821-2920`
- Modify: `tests/kugou-login-session-gate.test.js`

**Interfaces:**
- Consumes: `validateKugouPlaylistSession(cookie)` from `kugou-api.js`.
- Consumes: `createKugouLoginSessionGate(...)` from `desktop/kugou-login-session.js`.
- Existing IPC completion shape remains `{ ok, cookie, reused? }` only for validated sessions.

- [ ] **Step 1: Add a failing integration-boundary assertion**

In the gate test, load `desktop/main.js` as source and assert the login function creates and calls the gate, while the two old direct-success branches are absent:

```js
assert.match(mainSource, /createKugouLoginSessionGate/);
assert.match(mainSource, /await kugouSessionGate\.inspect\(initialCookie\)/);
assert.doesNotMatch(mainSource, /if \(kugouCookieHasPlayback\(initialCookie\)\) return \{ ok: true/);
assert.doesNotMatch(mainSource, /resolve\(kugouCookieHasPlayback\(cookie\)/);
```

This narrow wiring assertion complements the real gate behavior tests and catches accidental bypass of the tested state machine.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/kugou-login-session-gate.test.js tests/kugou-playlist-sync-resilience.test.js`

Expected: FAIL because `desktop/main.js` still completes from cookie shape alone.

- [ ] **Step 3: Replace cookie-shape completion with gate inspection**

In `desktop/main.js`:

1. import `validateKugouPlaylistSession` and `createKugouLoginSessionGate`;
2. construct the gate before inspecting `initialCookie`;
3. return `reused: true` only when `initialInspection.validated` is true;
4. when `initialInspection.reauthRequired` is true, clear the Kugou partition once and reset the gate before opening the window;
5. in `checkCookies`, call `inspect(cookie)` and finish only on `inspection.validated`;
6. keep the existing warmup navigation for identity-only cookies;
7. on close, succeed only when `gate.isValidated(cookie)` is true; otherwise return `{ ok: false, error: 'KUGOU_PLAYLIST_SESSION_NOT_VALIDATED', message: '酷狗登录未通过歌单同步验证，请重新登录' }`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/kugou-login-session-gate.test.js tests/kugou-playlist-sync-resilience.test.js`

Expected: all focused tests pass.

---

### Task 4: Complete verification

**Files:**
- Verify: `kugou-api.js`
- Verify: `desktop/kugou-login-session.js`
- Verify: `desktop/main.js`
- Verify: `tests/kugou-playlist-sync-resilience.test.js`
- Verify: `tests/kugou-login-session-gate.test.js`

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check kugou-api.js
node --check desktop/kugou-login-session.js
node --check desktop/main.js
```

Expected: all commands exit 0.

- [ ] **Step 2: Run focused account and playlist tests**

Run:

```powershell
node --test tests/kugou-login-session-gate.test.js tests/kugou-playlist-sync-resilience.test.js tests/kugou-vip-hardening.test.js tests/platform-account-sync-guard.test.js
```

Expected: zero failures.

- [ ] **Step 3: Run the complete Node test suite**

Run: `node --test --test-reporter=dot tests/*.test.js`

Expected: exit 0.

- [ ] **Step 4: Check patch formatting and scope**

Run: `git diff --check`

Review only the task files with:

```powershell
git diff -- kugou-api.js desktop/main.js desktop/kugou-login-session.js tests/kugou-playlist-sync-resilience.test.js tests/kugou-login-session-gate.test.js
```

Expected: no whitespace errors and no unrelated edits introduced by this task.

- [ ] **Step 5: Runtime handoff**

Ask the user to restart Electron and log into Kugou. A successful runtime sequence must contain `backend login-status`, a validated login completion, `backend parsed` with a nonzero mapped count for a nonempty account, `renderer catalog-rebuilt`, and `shelf rebuilt`. If provider code `20017` persists after the login window remains open for a fresh cookie change, report that external provider authorization remains blocked rather than claiming playlist display is fixed.
