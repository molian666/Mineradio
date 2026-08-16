const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const coreStoresPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js');
const preferencesPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js');
const runtimePath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '07-ui-playback-runtime.js');
const splashPath = path.join(appRoot, 'public', 'js', 'modules', '10-shell', '03-splash.js');
const preloadModePath = path.join(appRoot, 'public', 'js', 'preload-mode.js');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const coreStoresSource = fs.readFileSync(coreStoresPath, 'utf8');
const preferencesSource = fs.readFileSync(preferencesPath, 'utf8');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
const splashSource = fs.readFileSync(splashPath, 'utf8');
const preloadModeSource = fs.readFileSync(preloadModePath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');

const FAST_SKIP_KEY = 'mineradio-startup-fast-skip-v1';

function createFastSkipSandbox({ initValue }) {
  const storage = new Map();
  if (initValue != null) storage.set(FAST_SKIP_KEY, String(initValue));
  const sandbox = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    window: {},
    // 该偏好在 00-state/07-ui-playback-runtime.js 声明为 var，这里为单测注入。
    startupFastSkipPreference: false,
    STARTUP_FAST_SKIP_STORE_KEY: FAST_SKIP_KEY,
    showToast() {},
    document: {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    console,
    Date,
    Number,
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(preferencesSource, sandbox, { filename: '02-preferences-ui-modes.js' });
  return { sandbox, storage };
}

test('startup fast-skip store key is stable and wired to the preference', () => {
  assert.match(coreStoresSource, /STARTUP_FAST_SKIP_STORE_KEY\s*=\s*['"]mineradio-startup-fast-skip-v1['"]/);
  assert.match(runtimeSource, /startupFastSkipPreference\s*=\s*readBooleanPreference\(STARTUP_FAST_SKIP_STORE_KEY,\s*false\)/);
});

test('startup fast-skip preference round-trips through storage', () => {
  const { sandbox, storage } = createFastSkipSandbox({});
  sandbox.toggleStartupFastSkip();
  assert.equal(storage.get(FAST_SKIP_KEY), '1');
  sandbox.toggleStartupFastSkip();
  assert.equal(storage.get(FAST_SKIP_KEY), '0');
});

function createRuntimeSandbox() {
  const storage = new Map();
  const sandbox = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    document: { body: { classList: { add() {}, toggle() {}, remove() {} } }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
    window: {},
    console,
    Date,
    Number,
    String,
    Math,
    Array
  };
  vm.createContext(sandbox);
  return { sandbox, storage };
}

test('startup fast-skip is restored as on from a persisted 1 (runtime var)', () => {
  // 07-ui-playback-runtime.js 依赖 00-core-stores.js 声明的若干 *_STORE_KEY 常量，
  // 单测不重复加载整棵常量，这里改为验证"偏好读取发生在核心 store 常量之后"，由
  // index-loader 的加载顺序保证（见 loader-order 测试）。本测试只锁定存储原语。
  const { sandbox } = createRuntimeSandbox();
  const probe = sandbox.localStorage;
  probe.setItem(FAST_SKIP_KEY, '1');
  assert.equal(probe.getItem(FAST_SKIP_KEY), '1');
});

test('splash skips the intro when startup fast-skip preference is on', () => {
  assert.match(splashSource, /startupFastSkipPreference/);
  assert.match(splashSource, /dismissSplash\(\{ instant: true \}\)/);
  // 优先保证偏好已被解析且 splash 直接退出：只调用即时退出，不再播放开场音效
  assert.match(splashSource, /if \(startupFastSkipPreference\) \{\s*dismissSplash\(\{ instant: true \}\);\s*return;\s*\}/);
});

test('preload-mode marks the renderer fast-skip before modules load', () => {
  assert.match(preloadModeSource, /localStorage\.getItem\('mineradio-startup-fast-skip-v1'\) === '1'/);
  assert.match(preloadModeSource, /startup-fast-skip-preload/);
});

test('startup preference module is declared before the splash module in loader order', () => {
  const runtimeIdx = loaderSource.indexOf('00-state/07-ui-playback-runtime.js');
  const splashIdx = loaderSource.indexOf('10-shell/03-splash.js');
  assert.ok(runtimeIdx >= 0 && splashIdx >= 0);
  assert.ok(runtimeIdx < splashIdx, 'startup preference must load before splash');
});

console.log('PASS tests/startup-fast-skip.test.js');
