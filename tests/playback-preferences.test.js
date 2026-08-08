const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const preferencesPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js');
const coreStoresPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js');
const renderStatePath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '01-perf-render-state.js');
const playerControlsPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js');
const visualPersistencePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js');
const preferencesSource = fs.readFileSync(preferencesPath, 'utf8');
const coreStoresSource = fs.readFileSync(coreStoresPath, 'utf8');
const renderStateSource = fs.readFileSync(renderStatePath, 'utf8');
const playerControlsSource = fs.readFileSync(playerControlsPath, 'utf8');
const visualPersistenceSource = fs.readFileSync(visualPersistencePath, 'utf8');

function createPreferenceSandbox() {
  const storage = new Map();
  const sandbox = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    PLAY_MODE_STORE_KEY: 'mineradio-play-mode-v1',
    window: {},
    console,
    Number,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(preferencesSource, sandbox, { filename: '02-preferences-ui-modes.js' });
  return { sandbox, storage };
}

test('missing and invalid playback modes fall back to loop', () => {
  const { sandbox } = createPreferenceSandbox();
  assert.equal(sandbox.readPlayModePreference(), 'loop');
  sandbox.localStorage.setItem('mineradio-play-mode-v1', 'invalid');
  assert.equal(sandbox.readPlayModePreference(), 'loop');
});

test('supported playback modes round-trip through storage', () => {
  const { sandbox, storage } = createPreferenceSandbox();
  for (const mode of ['loop', 'shuffle', 'single']) {
    sandbox.savePlayModePreference(mode);
    assert.equal(storage.get('mineradio-play-mode-v1'), mode);
    assert.equal(sandbox.readPlayModePreference(), mode);
  }
});

test('storage failures do not interrupt playback preference access', () => {
  const sandbox = {
    localStorage: {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    },
    PLAY_MODE_STORE_KEY: 'mineradio-play-mode-v1',
    window: {},
    console,
    Number,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(preferencesSource, sandbox, { filename: '02-preferences-ui-modes.js' });
  assert.equal(sandbox.readPlayModePreference(), 'loop');
  assert.doesNotThrow(() => sandbox.savePlayModePreference('single'));
});

test('playback mode is restored at startup and saved when cycled', () => {
  assert.match(coreStoresSource, /PLAY_MODE_STORE_KEY\s*=\s*['"]mineradio-play-mode-v1['"]/);
  assert.match(renderStateSource, /playMode\s*=\s*readPlayModePreference\(\)/);
  assert.match(playerControlsSource, /savePlayModePreference\(playMode\)/);
});

test('existing volume and desktop lyrics persistence paths remain intact', () => {
  assert.match(preferencesSource, /apex-player-volume/);
  assert.match(visualPersistenceSource, /desktopLyrics/);
});

console.log('PASS tests/playback-preferences.test.js');
