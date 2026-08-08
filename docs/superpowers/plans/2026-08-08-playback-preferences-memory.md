# Playback Preferences Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the selected playback mode across renderer restarts while preserving the existing volume and desktop-lyrics persistence paths.

**Architecture:** Keep playback-mode persistence in the renderer's existing `localStorage` preference layer. Add one versioned key, `mineradio-play-mode-v1`, with a normalizer that accepts only `loop`, `shuffle`, and `single`; initialize the global `playMode` from it and write the value from `cyclePlayMode()`. Do not merge it into the visual autosave payload or the current-playback snapshot.

**Tech Stack:** Plain browser JavaScript modules concatenated by `public/js/index-loader.js`, Electron renderer storage, Node.js built-in `node:test`, `node:vm`, and `node:assert/strict`.

## Global Constraints

- Missing storage, malformed storage, and unknown mode values resolve to `loop`.
- Storage read/write failures are swallowed consistently with the existing preference helpers.
- Existing saved volume and visual settings must not be overwritten.
- The public mode labels, icons, shuffle reordering, and next-track behavior remain unchanged.
- No new dependency or Electron IPC path is needed.
- Do not modify unrelated existing worktree changes.

---

### Task 1: Add failing persistence tests

**Files:**
- Create: `tests/playback-preferences.test.js`
- Read: `public/js/modules/00-state/00-core-stores.js`
- Read: `public/js/modules/00-state/02-preferences-ui-modes.js`
- Read: `public/js/modules/00-state/01-perf-render-state.js`
- Read: `public/js/modules/05-playback/14-player-controls.js`
- Read: `public/js/modules/02-visual/04-visual-settings-persistence.js`

**Interfaces:**
- Consumes: the current preference helper conventions and the three existing mode values used by `cyclePlayMode()`.
- Produces: executable regression coverage for `readPlayModePreference()`, `savePlayModePreference()`, and the startup/cycle integration points.

- [ ] **Step 1: Write the failing test**

Create a Node test file that loads the preference module in a `vm` context with a real in-memory `localStorage` implementation:

```js
const storage = new Map();
const sandbox = {
  localStorage: {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
  PLAY_MODE_STORE_KEY: 'mineradio-play-mode-v1',
  console,
  Number,
  String,
};
vm.createContext(sandbox);
vm.runInContext(preferencesSource, sandbox, { filename: '02-preferences-ui-modes.js' });
```

Add tests for these exact behaviors:

```js
test('missing and invalid playback modes fall back to loop', () => {
  assert.equal(sandbox.readPlayModePreference(), 'loop');
  sandbox.localStorage.setItem('mineradio-play-mode-v1', 'invalid');
  assert.equal(sandbox.readPlayModePreference(), 'loop');
});

test('supported playback modes round-trip through storage', () => {
  for (const mode of ['loop', 'shuffle', 'single']) {
    sandbox.savePlayModePreference(mode);
    assert.equal(sandbox.readPlayModePreference(), mode);
  }
});
```

Also assert the real state/control sources contain the integration calls:

```js
assert.match(renderStateSource, /playMode\s*=\s*readPlayModePreference\(\)/);
assert.match(playerControlsSource, /savePlayModePreference\(playMode\)/);
```

Add a source regression assertion that the existing keys remain unchanged:

```js
assert.match(coreStoresSource, /PLAY_MODE_STORE_KEY\s*=\s*'mineradio-play-mode-v1'/);
assert.match(preferencesSource, /apex-player-volume/);
assert.match(visualPersistenceSource, /desktopLyrics/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test tests/playback-preferences.test.js
```

Expected: FAIL because `readPlayModePreference` and `savePlayModePreference` do not exist and the startup source still initializes `playMode` with the literal `loop`.

### Task 2: Implement playback-mode persistence

**Files:**
- Modify: `public/js/modules/00-state/00-core-stores.js` near the other versioned local-storage keys
- Modify: `public/js/modules/00-state/02-preferences-ui-modes.js` near the other scalar preference helpers
- Modify: `public/js/modules/00-state/01-perf-render-state.js` at the `playMode` declaration
- Modify: `public/js/modules/05-playback/14-player-controls.js` inside `cyclePlayMode()`
- Test: `tests/playback-preferences.test.js`

**Interfaces:**
- Consumes: `PLAY_MODE_STORE_KEY`, `normalizePlayMode()`, `readPlayModePreference()`, and `savePlayModePreference()`.
- Produces: startup mode restoration and mode writes without changing playback transition behavior.

- [ ] **Step 1: Add the versioned storage key**

In `00-core-stores.js`, add this alongside `LAST_PLAYBACK_STORE_KEY` and the other renderer preference keys:

```js
var PLAY_MODE_STORE_KEY = 'mineradio-play-mode-v1';
```

- [ ] **Step 2: Add normalized read/write helpers**

In `02-preferences-ui-modes.js`, add helpers matching the existing `try/catch` storage style:

```js
function normalizePlayMode(mode) {
  mode = String(mode || '').trim();
  return /^(loop|shuffle|single)$/.test(mode) ? mode : 'loop';
}
function readPlayModePreference() {
  try { return normalizePlayMode(localStorage.getItem(PLAY_MODE_STORE_KEY) || 'loop'); }
  catch (e) { return 'loop'; }
}
function savePlayModePreference(mode) {
  try { localStorage.setItem(PLAY_MODE_STORE_KEY, normalizePlayMode(mode)); }
  catch (e) { }
}
```

- [ ] **Step 3: Restore the mode during state initialization**

In `01-perf-render-state.js`, replace only the `playMode = 'loop'` initializer with:

```js
var queueViewTab = readPlaylistPanelTabPreference(), playMode = readPlayModePreference(), miniQueueOpen = false;
```

Keep the existing declaration order and all queue state untouched. The loader concatenates the modules into one script, so the function declaration is available when the initializer runs.

- [ ] **Step 4: Save after a user mode cycle**

In `cyclePlayMode()`, call `savePlayModePreference(playMode)` after the existing shuffle reorder branch and before `updatePlayModeButton(true)`. Do not change the mode array, reorder call, toast, or button update.

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```powershell
node --test tests/playback-preferences.test.js
```

Expected: PASS for fallback, round-trip, startup integration, cycle integration, and preservation of the existing volume/desktop-lyrics paths.

### Task 3: Verify syntax and regressions

**Files:**
- Verify: `public/js/modules/00-state/00-core-stores.js`
- Verify: `public/js/modules/00-state/01-perf-render-state.js`
- Verify: `public/js/modules/00-state/02-preferences-ui-modes.js`
- Verify: `public/js/modules/05-playback/14-player-controls.js`
- Verify: `tests/playback-preferences.test.js`

**Interfaces:**
- Consumes: the implementation and focused tests from Tasks 1-2.
- Produces: evidence that the new preference does not break existing renderer modules or the repository test suite.

- [ ] **Step 1: Run JavaScript syntax checks**

Run:

```powershell
node --check public/js/modules/00-state/00-core-stores.js
node --check public/js/modules/00-state/01-perf-render-state.js
node --check public/js/modules/00-state/02-preferences-ui-modes.js
node --check public/js/modules/05-playback/14-player-controls.js
node --check tests/playback-preferences.test.js
```

Expected: every command exits successfully.

- [ ] **Step 2: Run the full Node test suite**

Run:

```powershell
node --test tests
```

Expected: all existing tests and `tests/playback-preferences.test.js` pass. Any failure in unrelated dirty-worktree code must be reported with its test name and must not be fixed as part of this feature.

- [ ] **Step 3: Inspect the final diff**

Run:

```powershell
git diff -- public/js/modules/00-state/00-core-stores.js public/js/modules/00-state/01-perf-render-state.js public/js/modules/00-state/02-preferences-ui-modes.js public/js/modules/05-playback/14-player-controls.js tests/playback-preferences.test.js
```

Confirm the diff only adds the versioned playback-mode preference, its two integration points, and focused tests; do not stage or revert unrelated worktree changes.

- [ ] **Step 4: Commit only feature files**

Run:

```powershell
git add -- public/js/modules/00-state/00-core-stores.js public/js/modules/00-state/01-perf-render-state.js public/js/modules/00-state/02-preferences-ui-modes.js public/js/modules/05-playback/14-player-controls.js tests/playback-preferences.test.js
git commit -m "feat: remember playback mode"
```

The commit must contain exactly these five files.
