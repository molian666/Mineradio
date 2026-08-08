# QQ Like Local Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the QQ like button use merged-playlist local collection directly, with matching add/remove state and user feedback.

**Architecture:** Treat the existing merged local-collection store as the QQ like source of truth. Add a small membership helper and make local removal report storage success. In the shared like flow, branch for QQ before login/API handling; QQ updates local storage and UI directly, while all other providers continue through their existing account APIs. QQ like-status refreshes also read local membership instead of calling the remote like-check endpoint.

**Tech Stack:** Browser JavaScript modules, localStorage, Node.js built-in test runner, existing source-contract and VM regression tests.

## Global Constraints

- QQ liking must not call `/api/qq/song/like` or require QQ login.
- Use `QQ 音乐同步暂未实现，已加入合并歌单（本地收藏）` after a successful local add.
- Use `已从合并歌单移除（本地收藏）` after a successful local removal.
- Use `QQ 音乐同步暂未实现，本地收藏失败` when a local add cannot be persisted.
- Existing like behavior for Netease, Kugou, Spotify, and Qishui remains unchanged.
- Preserve unrelated uncommitted work in the repository.

---

### Task 1: Add failing QQ local-like regression coverage

**Files:**
- Modify: `tests/playlist-remove-sync.test.js`
- Read: `public/js/modules/05-playback/06-track-detail-lyrics-actions.js`
- Read: `public/js/modules/06-lyrics/01a-merged-playlist.js`

**Interfaces:**
- Consumes: `toggleLikeSong`, `mergedAddLocalCollectSong`, `mergedRemoveLocalCollectSong`, and the merged local store.
- Produces: Regression assertions for direct QQ local add/remove, exact toasts, local membership lookup, and no QQ like API call in the QQ branch.

- [ ] **Step 1: Write the failing test**

  Extend the existing merged-playlist test with assertions that `01a-merged-playlist.js` defines `mergedHasLocalCollectSong`, returns `saveMergedLocalCollectSongs(...)` from `mergedRemoveLocalCollectSong`, and that the QQ branch in `toggleLikeSong` appears before `ensureLoggedInForAction` and contains the two exact success messages plus the local add/remove calls. Assert the extracted QQ branch does not invoke `adapter.likeUrl`.

- [ ] **Step 2: Run the test to verify it fails**

  Run `node --test tests/playlist-remove-sync.test.js`.

  Expected: the new assertion fails because the current like flow has no QQ-local branch and the merged helper has no local-membership function.

### Task 2: Implement QQ local-like behavior

**Files:**
- Modify: `public/js/modules/06-lyrics/01a-merged-playlist.js` around the local collection helpers
- Modify: `public/js/modules/05-playback/06-track-detail-lyrics-actions.js` in `isSongLiked`, `syncLikeStatusForSongs`, and `toggleLikeSong`

**Interfaces:**
- Consumes: `mergedHasLocalCollectSong(song)`, `mergedAddLocalCollectSong(song)`, `mergedRemoveLocalCollectSong(song)`, and `markMergedPlaylistDirty(reason)`.
- Produces: QQ local membership as the like state, direct local add/remove with exact toasts, and unchanged API flow for non-QQ providers.

- [ ] **Step 1: Implement the merged local membership contract**

  Add `mergedHasLocalCollectSong(song)` to compare `mergedLocalCollectKey(song)` against `readMergedLocalCollectSongs()`. Change `mergedRemoveLocalCollectSong(song)` to return the boolean from `saveMergedLocalCollectSongs(...)`, so a failed write cannot be reported as a successful removal.

- [ ] **Step 2: Implement the QQ-only like-state path**

  In `isSongLiked(song)`, return `mergedHasLocalCollectSong(song)` for QQ songs. In `syncLikeStatusForSongs`, update QQ state from local membership and exclude QQ from remote like-check request groups. In `toggleLikeSong`, calculate the local next state and, before `ensureLoggedInForAction` or the generic `apiJson(adapter.likeUrl, ...)` path, call `mergedAddLocalCollectSong(song)` for add or `mergedRemoveLocalCollectSong(song)` for remove. On success update `likedSongMap`, invalidate merged cache, refresh existing like/search/queue UI, and show the exact add/remove toast. On failed add show the exact local-failure toast and leave the state unliked.

- [ ] **Step 3: Run the focused test to verify it passes**

  Run `node --test tests/playlist-remove-sync.test.js`.

  Expected: all playlist synchronization tests pass, including the new QQ local-like contract.

### Task 3: Run full verification and review the diff

**Files:**
- Verify: `public/js/modules/05-playback/06-track-detail-lyrics-actions.js`
- Verify: `public/js/modules/06-lyrics/01a-merged-playlist.js`
- Verify: `tests/playlist-remove-sync.test.js`

- [ ] **Step 1: Run the full Node test set**

  Run `node --test tests/*.test.js` and confirm zero failures.

- [ ] **Step 2: Check formatting and scope**

  Run `git diff --check` and inspect the relevant diff. Confirm no unrelated provider or desktop changes were modified.
