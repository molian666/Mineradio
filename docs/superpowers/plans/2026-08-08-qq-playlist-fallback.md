# QQ Music Playlist Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve songs locally in the merged playlist and clearly tell the user when QQ Music playlist synchronization is unavailable.

**Architecture:** Keep the existing QQ playlist request as the primary write path. In its failure handler, call the merged playlist local-collection helper, invalidate merged-playlist cache state, and choose the user-facing toast based on whether local persistence succeeds. Non-QQ providers retain their existing failure handling.

**Tech Stack:** Browser JavaScript modules, localStorage-backed merged-playlist state, Node.js built-in test runner and source-contract regression tests.

## Global Constraints

- Use the exact success fallback copy: `同步到 QQ 音乐暂未实现，已加入合并歌单（本地收藏）`.
- Use the exact local-fallback failure copy: `同步到 QQ 音乐暂未实现`.
- Do not change QQ Music API behavior or non-QQ provider error handling.
- Preserve unrelated uncommitted work in the repository.

---

### Task 1: Lock the QQ fallback contract with a regression test

**Files:**
- Modify: `tests/playlist-remove-sync.test.js` in the merged-playlist local-collection test
- Read: `public/js/modules/05-playback/06-track-detail-lyrics-actions.js`
- Read: `public/js/modules/06-lyrics/01a-merged-playlist.js`

**Interfaces:**
- Consumes: `mergedAddLocalCollectSong(song)` and the QQ collection failure branch in `addCollectTargetToPlaylist`.
- Produces: A focused regression assertion covering the fallback call and both user-facing message outcomes.

- [ ] **Step 1: Write the failing test**

  Add a focused test that extracts the QQ failure branch and verifies it contains the local fallback call, the exact success message, and the exact fallback-failure message. The test must distinguish the two message branches so a generic `暂未实现` toast cannot pass.

- [ ] **Step 2: Run the test to verify it fails**

  Run `node --test tests/playlist-remove-sync.test.js`.

  Expected: the new assertion fails if either exact message or the local fallback call is absent; an assertion failure is required before implementation changes.

- [ ] **Step 3: Implement the minimal production behavior**

  In `addCollectTargetToPlaylist` in `public/js/modules/05-playback/06-track-detail-lyrics-actions.js`, keep the existing QQ API attempt. In the QQ-only `catch` branch, call `mergedAddLocalCollectSong(targetSong)`, schedule `markMergedPlaylistDirty('playlist-collect-local')` when available, close the modal, and show the exact success or fallback-failure copy based on the boolean result.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run `node --test tests/playlist-remove-sync.test.js` and confirm the focused suite passes without unrelated failures.

- [ ] **Step 5: Run repository-level relevant checks**

  Run `node --test tests/merged-playlist-cache.test.js tests/merged-playlist-defaults.test.js tests/merged-playlist-streaming.test.js tests/playlist-remove-sync.test.js`.

- [ ] **Step 6: Review the diff**

  Run `git diff --check` and inspect only the plan, test, and behavior-related changes. Confirm no unrelated user modifications were altered.
