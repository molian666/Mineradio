# Runtime Resource Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Mineradio's CPU and memory use during long-running foreground and background sessions while preserving playback and visual synchronization.

**Architecture:** Keep the current Electron/Three.js architecture. Add a small CommonJS bounded-cache utility for main-process maps, add explicit active/idle/background scheduling to the existing renderer loop, and replace always-on renderer maintenance intervals with feature-scoped timers. Preserve existing deep-background rendering and cache-trim behavior.

**Tech Stack:** Electron 42, plain browser JavaScript loaded by `public/js/index-loader.js`, Node.js `node:test`, Three.js r128, CommonJS.

## Global Constraints

- Active playback and interaction retain VSync rendering and required audio/lyrics/beat synchronization.
- Hidden/minimized windows must not perform high-frequency 3D rendering.
- Current-song, nearby-queue, in-flight, and visible resources remain protected from cache eviction.
- No new runtime dependency is added.
- Existing uncommitted user changes remain untouched unless a listed file is required by this plan.
- Do not force system-wide memory purges while Mineradio is visible.

---

### Task 1: Add and Test Bounded Cache Primitives

**Files:**
- Create: `server/runtime-bounded-cache.js`
- Create: `tests/runtime-bounded-cache.test.js`

**Interfaces:**
- Produces `createBoundedTtlCache({ maxEntries, ttlMs, now })` with `get(key)`, `set(key, value, ttlMs)`, `has(key)`, `delete(key)`, `clear()`, and `size`.
- Produces `createByteBoundedCache({ maxBytes, valueBytes, now })` with the same methods plus `bytes`.
- `get` refreshes access order and removes expired entries; `set` replaces an existing key without double-counting it; eviction removes the oldest cache entry by access order.

- [ ] **Step 1: Write failing tests for TTL and LRU behavior**

```js
test('bounded TTL cache expires entries and evicts least recently used entries', () => {
  let now = 0;
  const cache = createBoundedTtlCache({ maxEntries: 2, ttlMs: 100, now: () => now });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  now = 101;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 1);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --test tests/runtime-bounded-cache.test.js`

Expected: FAIL because `server/runtime-bounded-cache.js` does not exist.

- [ ] **Step 3: Implement the minimal cache primitives**

Use a `Map` whose delete-and-set sequence refreshes insertion order. On `set`, delete the previous record first, store `expiresAt`, and evict while the map exceeds `maxEntries`. For the byte cache, subtract the replaced record's byte count before adding the new value and decrement `bytes` whenever an entry is removed.

- [ ] **Step 4: Add byte-accounting regression tests**

```js
test('byte bounded cache replaces a key without accumulating stale bytes', () => {
  const cache = createByteBoundedCache({ maxBytes: 5, valueBytes: value => value.length });
  cache.set('song', Buffer.alloc(4));
  cache.set('song', Buffer.alloc(2));
  assert.equal(cache.bytes, 2);
  cache.set('other', Buffer.alloc(4));
  assert.equal(cache.bytes, 4);
  assert.equal(cache.get('song'), undefined);
});
```

- [ ] **Step 5: Run the focused tests and commit**

Run: `node --test tests/runtime-bounded-cache.test.js`

Expected: PASS with all cache behavior assertions passing.

Commit: `git add server/runtime-bounded-cache.js tests/runtime-bounded-cache.test.js && git commit -m "perf: add bounded runtime cache primitives"`

### Task 2: Bound Main-Process Provider Caches

**Files:**
- Modify: `server.js:177-180, 1367-1395, 1458-1592, 1839, 2730-2798, 2939-2970`
- Test: `tests/runtime-bounded-cache.test.js`
- Create: `tests/server-cache-bounds.test.js`

**Interfaces:**
- Consumes the cache primitives from `server/runtime-bounded-cache.js`.
- Keeps existing cache value shapes and provider TTL constants.
- Keeps `server.clearAllLoginCredentials` and all provider request handlers unchanged from their callers' perspective.

- [ ] **Step 1: Write failing source-contract tests**

Assert that `server.js` requires the bounded-cache module, constructs bounded caches for QQ VIP, QQ liked playlist covers, and Netease source matches, and uses the byte cache for Qishui decrypted audio. Assert that the Qishui replacement path subtracts the old payload before adding the new payload.

- [ ] **Step 2: Run the source-contract test and verify it fails**

Run: `node --test tests/server-cache-bounds.test.js`

Expected: FAIL because the required import and bounded-cache constructions are absent.

- [ ] **Step 3: Integrate bounded caches without changing response formats**

Replace the unbounded `Map` instances with bounded caches using conservative limits: 256 QQ VIP entries, 256 QQ liked-cover entries, and 256 Netease source-match entries. Retain the existing positive/negative TTL decisions by passing their TTL at `set` time. Replace Qishui's manual byte accounting with the byte cache configured at 96 MB and `valueBytes: value => value.buffer.length`.

- [ ] **Step 4: Preserve access freshness and clear behavior**

Ensure cache reads refresh access order, expired entries return misses, login clearing calls `clear()`, and a replacement with the same key leaves byte usage equal to the replacement payload only. Keep Netease playlist-track cache's existing dedicated policy unchanged.

- [ ] **Step 5: Run focused provider tests and commit**

Run: `node --test tests/runtime-bounded-cache.test.js tests/server-cache-bounds.test.js tests/qq-vip-entitlement.test.js tests/qishui-entitlement-cache.test.js`

Expected: PASS with no provider behavior regressions.

Commit: `git add server.js tests/server-cache-bounds.test.js && git commit -m "perf: bound provider runtime caches"`

### Task 3: Make the Renderer Loop Lifecycle-Aware

**Files:**
- Modify: `public/js/modules/11-main-loop.js:160-300, 310-700`
- Modify: `public/js/index-loader.js:10-14` if a scheduler helper is introduced
- Create: `tests/runtime-render-scheduling.test.js`

**Interfaces:**
- Keeps `requestMainLoopAnimationFrame`, `wakeMainLoopFromBackground`, `mainFrameGates`, and `window.__mineradioMainFrameGates` available.
- Adds a small `mainLoopRuntimeMode(now)`/equivalent helper returning `active`, `visible-idle`, or `deep-background` using existing playback, interaction, visibility, and desktop runtime state.

- [ ] **Step 1: Write failing scheduling contract tests**

Read the main-loop source and assert that active playback uses VSync, visible idle has a lower bounded cadence, deep background uses the delayed timer, and a wake path clears the pending timer before requesting a frame. Assert that delayed frames clamp `dt` and do not replay unbounded accumulated gate time.

- [ ] **Step 2: Run the scheduling test and verify the missing behavior**

Run: `node --test tests/runtime-render-scheduling.test.js`

Expected: FAIL on the visible-idle cadence and lifecycle assertions.

- [ ] **Step 3: Implement the smallest lifecycle-aware cadence change**

Keep active playback and interaction on the current RAF path. Add visible-idle cadence selection at a conservative fixed rate, skip analyser reads unless media is currently playing, and preserve the current deep-background timer path. Ensure `scheduleNextMainLoopFrame` never schedules both a timer and RAF for the same cycle, and clamp pending gate deltas after a long sleep.

- [ ] **Step 4: Add wake calls at existing state transition boundaries**

Use the existing visibility/focus handlers and playback/interaction hooks to call `wakeMainLoopFromBackground` or an equivalent immediate-frame helper. Do not add a polling timer solely to detect state changes.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/runtime-render-scheduling.test.js tests/main-window-runtime-recovery.test.js tests/playback-audio-graph-recovery.test.js`

Expected: PASS with existing recovery and playback behavior intact.

Commit: `git add public/js/modules/11-main-loop.js tests/runtime-render-scheduling.test.js && git commit -m "perf: make renderer cadence lifecycle-aware"`

### Task 4: Stop Always-On Renderer Maintenance Timers

**Files:**
- Modify: `public/js/modules/06-lyrics/04-progress-seek.js:492-521`
- Modify: `public/js/modules/10-shell/04-desktop-overlay-fullscreen.js:1445-1452, 1590-1620, pagehide hooks`
- Create: `tests/runtime-maintenance-timers.test.js`

**Interfaces:**
- Progress maintenance exposes internal timer helpers only through local functions and retains `updateListenStatsTick`, `updatePlaybackProgressUi`, and `saveLastPlaybackSnapshot` behavior.
- Desktop overlay health sync retains `syncDesktopOverlayState` and existing IPC payload/deduplication behavior.

- [ ] **Step 1: Write failing timer lifecycle tests**

Assert that the progress module does not contain an unconditional `setInterval(..., 200)`, that paused/unloaded states clear the maintenance timer, and that the desktop overlay module does not contain an unconditional `setInterval(..., 320)`.

- [ ] **Step 2: Run the timer test and verify it fails**

Run: `node --test tests/runtime-maintenance-timers.test.js`

Expected: FAIL because both unconditional intervals currently exist.

- [ ] **Step 3: Implement feature-scoped progress maintenance**

Replace the global interval with `scheduleProgressMaintenance` and `clearProgressMaintenance`. Schedule visible playback work only while media is active, schedule the one-second hidden snapshot only while background playback is active, and clear the timer when playback pauses, ends, or the media is absent. Keep explicit event-driven progress updates unchanged.

- [ ] **Step 4: Implement feature-scoped desktop overlay health checks**

Replace the global health interval with a single owned timer that starts when desktop lyrics or wallpaper mode becomes active, stops when both are disabled, and is cleared on `pagehide`. Keep `syncDesktopOverlayState` and `ensureDesktopWallpaperFunctionalUi('health-watch')` as the callback body.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/runtime-maintenance-timers.test.js tests/desktop-native-icon-layer-runtime.test.js tests/full-desktop-mode-runtime.test.js`

Expected: PASS with no extra timer when desktop features are disabled.

Commit: `git add public/js/modules/06-lyrics/04-progress-seek.js public/js/modules/10-shell/04-desktop-overlay-fullscreen.js tests/runtime-maintenance-timers.test.js && git commit -m "perf: scope renderer maintenance timers"`

### Task 5: Enforce Renderer Cache Bounds and Verify the Release

**Files:**
- Modify: `public/js/modules/00-state/08-desktop-render-power.js:220-276, 357-399`
- Modify: `public/js/index-loader.js:10-14` if a renderer cache helper is introduced
- Modify: `public/js/modules/04-shelf/04-cover-api-helpers.js:20-50`
- Modify: `public/js/modules/03-beat/04-beat-map-runtime.js:1-35`
- Modify: `public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js:280-310, 435-455`
- Modify: `public/js/modules/03-beat/02-podcast-dj-analysis.js:780-800`
- Modify: `public/js/modules/05-playback/18-cuefield-automix-integration.js:70-95`
- Create: `tests/renderer-cache-bounds.test.js`

**Interfaces:**
- Existing cache globals `playlistCoverCache`, `beatMapCache`, `djBeatMapCache`, and `cuefieldAudioDescriptorCache` remain readable by current modules.
- Adds one shared renderer helper, such as `rememberRuntimeCacheEntry(cache, key, value, limit, protectedKeys)`, loaded before consumers if needed. It must never evict `loading` cover records or protected current/nearby entries.

- [ ] **Step 1: Write failing cache-bound tests**

Assert that renderer insertion paths invoke the shared bound helper, that the helper preserves protected keys, and that cache counts reported by `collectRuntimePerfSnapshot` remain at or below the configured limits after repeated inserts.

- [ ] **Step 2: Run the renderer cache test and verify it fails**

Run: `node --test tests/renderer-cache-bounds.test.js`

Expected: FAIL because insertion paths currently assign directly without a shared bound operation.

- [ ] **Step 3: Implement bounded insertion and access updates**

Use access-order metadata for inserted/read entries, keep in-flight and current/nearby entries protected, and evict only completed non-protected values. Invoke the helper at cover, normal beat-map, DJ beat-map, and Cuefield descriptor insertion points. Keep the existing aggressive background cleanup and Three.js disposal rules.

- [ ] **Step 4: Add long-run runtime snapshot assertions**

Assert that `collectRuntimePerfSnapshot` exposes bounded cache counts and that aggressive cleanup clears the stage lyric track cache without disposing the active lyric mesh.

- [ ] **Step 5: Run the complete verification set**

Run: `node --test tests`

Expected: PASS with zero failures.

Run: `node --check server/runtime-bounded-cache.js; node --check server.js; node --check desktop/main.js`

Expected: all modified CommonJS files parse successfully.

Run: `git diff --check HEAD~5..HEAD`

Expected: no whitespace errors in the implementation commits.

Run: `npm run build:win:dir`

Expected: exit code 0 when the local Electron/electron-builder toolchain is available; otherwise record the exact environment failure without claiming a successful build.

- [ ] **Step 6: Review the final diff and commit**

Run: `git status --short; git diff --stat HEAD~5..HEAD`

Confirm only planned files changed in the implementation commits and that existing unrelated worktree changes remain untouched.

Commit: `git commit -m "perf: reduce long-running runtime resource use"`
