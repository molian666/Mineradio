# Kugou Playlist Sync Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the last successful Kugou playlist catalog visible across transient refresh failures while making successful login/token states trigger reliable synchronization.

**Architecture:** Keep playlist catalog replacement transactional in the renderer: provider arrays are replaced only after a valid response, while failed requests retain their previous rows and expose an error state for retry. Add a small pure synchronization helper for the success/failure decision so the behavior is testable without a browser. Normalize Kugou account capability handling so a recognized account without a usable playback token is not treated as fully syncable.

**Tech Stack:** Node.js, Electron renderer JavaScript, Node built-in test runner.

## Global Constraints

- Preserve unrelated user changes already present in the working tree.
- Do not add dependencies.
- Do not persist stale playlist data as if it were a successful fresh sync.
- A failed refresh must never replace a non-empty successful catalog with an empty array.
- Successful empty results remain valid only when the provider explicitly reports a successful response.

---

### Task 1: Add failing regression tests

**Files:**
- Create: `tests/kugou-playlist-sync-resilience.test.js`
- Read: `public/js/modules/06-lyrics/01-playlist-panel-shell.js`

**Interfaces:**
- Test the renderer helper `applyPlaylistCatalogSyncResult(previousRows, response)`.
- Expected result shape: `{ rows, synced, error }`.

- [ ] **Step 1: Write tests for failed and successful responses**

Cover:
- a failed response with `error` and no playlists preserves the previous rows;
- a thrown request error preserves the previous rows;
- a successful response replaces the previous rows, including a legitimate empty successful result.

- [ ] **Step 2: Run the focused test before implementation**

Run: `node.exe --test tests/kugou-playlist-sync-resilience.test.js`

Expected: FAIL because the helper is not exported/available yet.

---

### Task 2: Implement transactional catalog application

**Files:**
- Modify: `public/js/modules/06-lyrics/01-playlist-panel-shell.js:551-590`
- Modify: `tests/kugou-playlist-sync-resilience.test.js`

**Interfaces:**
- Add `applyPlaylistCatalogSyncResult(previousRows, response)` in the renderer module.
- Keep the existing provider array unchanged when the response has an error, when the request throws, or when the response is not a valid object.
- In `loadPlaylistCatalogProviderPage`, only commit incoming rows after the response passes validation.
- Keep `state.error` and `state.hasMore` updates so the background retry mechanism can continue.

- [ ] **Step 1: Implement the minimal helper and wire it into the loader**
- [ ] **Step 2: Run the focused regression test**

Run: `node.exe --test tests/kugou-playlist-sync-resilience.test.js`

Expected: PASS.

- [ ] **Step 3: Run the existing playlist synchronization tests**

Run: `node.exe --test tests/merged-playlist-streaming.test.js tests/merged-playlist-cache.test.js tests/playlist-remove-sync.test.js`

Expected: PASS.

---

### Task 3: Prevent incomplete Kugou capability from entering playlist sync

**Files:**
- Modify: `public/js/modules/08-account/02-login-status.js:287-379`
- Modify: `public/js/modules/06-lyrics/01-playlist-panel-shell.js:507-513`
- Modify: `tests/kugou-playlist-sync-resilience.test.js`

**Interfaces:**
- Treat `kugouLoginStatus.loggedIn` as account identity state.
- Use `playbackKeyReady` for the authenticated playlist provider capability.
- When the account is recognized but the token is incomplete, avoid destructive playlist clearing and surface the existing stale/error path until the next refresh.

- [ ] **Step 1: Add a failing test for incomplete-token status preservation**
- [ ] **Step 2: Run the focused test and confirm it fails for the expected reason**
- [ ] **Step 3: Implement the smallest capability guard**
- [ ] **Step 4: Run the focused and existing Kugou tests**

Run: `node.exe --test tests/kugou-playlist-sync-resilience.test.js tests/kugou-vip-hardening.test.js tests/provider-entitlement-boundary.test.js tests/home-platform-top-playlists.test.js`

Expected: PASS.

---

### Task 4: Verify the complete change

**Files:**
- Read: `git diff --check`
- Read: `git status --short`

- [ ] **Step 1: Run all focused tests**
- [ ] **Step 2: Run the full available Node test suite**

Run: `node.exe --test tests/*.test.js`

Expected: zero failures.

- [ ] **Step 3: Review the diff for scope and accidental changes**
- [ ] **Step 4: Run `git diff --check`**
- [ ] **Step 5: Report exact verification results and remaining external dependency risk**
