# Playlist Mutation Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成所有平台歌单删除/歌曲移出入口，并同步普通平台、合并歌单和本地 QQ 排除状态。

**Architecture:** 使用现有平台 adapter 和 `removeSongFromSourcePlaylist`/`deletePlaylistByKey` 作为统一变更入口。合并歌单增加持久化的本地排除记录，重建快照和流式分页时统一过滤；UI 只负责展示和调用，不复制平台逻辑。

**Tech Stack:** Electron renderer JavaScript, Node.js `node:test`, IndexedDB/localStorage, existing platform adapters.

## Global Constraints

- 保留工作区中与本任务无关的未提交修改。
- 不为酷狗或汽水伪造整张歌单删除成功。
- QQ 合并歌单移除只更新本地，不调用 QQ 平台移除接口。
- 使用现有 toast、adapter、缓存和 3D 歌单架刷新机制。

---

### Task 1: Add regression tests for unsupported deletion and QQ local removal

**Files:**
- Modify: `tests/playlist-remove-sync.test.js`

- [ ] **Step 1: Write failing assertions** for detail/shelf delete visibility, unsupported toast path, QQ merged branch, and merged local-removal filtering.
- [ ] **Step 2: Run `node --test tests/playlist-remove-sync.test.js`** and confirm the new assertions fail against the current implementation.

### Task 2: Persist and apply merged-playlist local removals

**Files:**
- Modify: `public/js/modules/06-lyrics/01a-merged-playlist.js`
- Test: `tests/playlist-remove-sync.test.js`

- [ ] **Step 1: Add local removal storage and stable source/song keys.**
- [ ] **Step 2: Filter removed tracks in source records, snapshot merging, and streaming pagination.**
- [ ] **Step 3: Run the focused test and confirm it passes.**

### Task 3: Route QQ merged removal locally and show unsupported delete feedback

**Files:**
- Modify: `public/js/modules/06-lyrics/02-playlist-detail.js`
- Modify: `public/js/modules/04-shelf/01-manager-core.js`
- Modify: `tests/playlist-remove-sync.test.js`

- [ ] **Step 1: Add the QQ merged local branch before platform API calls.**
- [ ] **Step 2: Make eligible detail and shelf delete buttons visible even when the adapter has no delete endpoint.**
- [ ] **Step 3: Keep unsupported deletion as a toast-only failure and preserve local catalogs.**
- [ ] **Step 4: Run focused tests and syntax checks.**

### Task 4: Verify all related behavior

**Files:**
- No source changes.

- [ ] **Step 1: Run `node --test tests/playlist-remove-sync.test.js`.**
- [ ] **Step 2: Run `node --test --test-reporter=dot tests/*.test.js`.**
- [ ] **Step 3: Run `node --check` on modified JavaScript files and `git diff --check`.**
