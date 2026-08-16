const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const seekPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js');
const cssPath = path.join(appRoot, 'public', 'css', 'index.css');
const seekSource = fs.readFileSync(seekPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');

function createBarMock(width, left) {
  const listeners = {};
  const bar = {
    width,
    left,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    getBoundingClientRect() {
      return { left: this.left, width: this.width };
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    _listeners: listeners
  };
  return bar;
}

function createSandbox() {
  const timeDisplay = { textContent: '' };
  const tooltip = {
    textContent: '',
    styleProps: {},
    style: {
      setProperty(name, value) {
        tooltip.styleProps[name] = String(value);
      }
    }
  };
  const progressBar = createBarMock(200, 100);
  const sandbox = {
    console,
    window: { addEventListener() {} },
    document: {
      addEventListener() {},
      getElementById(id) {
        if (id === 'progress-bar') return progressBar;
        if (id === 'time-display') return timeDisplay;
        if (id === 'progress-tooltip') return tooltip;
        return null;
      }
    },
    progressDragState: { active: false, previewDuration: 0 },
    audio: { currentTime: 30, duration: 200 },
    playing: false,
    getPlaybackDurationSeconds: () => 200,
    getPlaybackCurrentSeconds: () => 30,
    formatProgramTime: (sec) => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + String(s).padStart(2, '0');
    },
    clampRange: (v, min, max) => Math.max(min, Math.min(max, v)),
    setProgressVisual() {},
    updatePlaybackProgressUi() {
      sandbox.updateCalls = (sandbox.updateCalls || 0) + 1;
    },
    isProgressDragPreviewActive: () => false,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    Math,
    Number,
    String,
    Array,
    Object,
    Date,
    isFinite
  };
  sandbox.progressBar = progressBar;
  sandbox.timeDisplay = timeDisplay;
  sandbox.tooltip = tooltip;
  sandbox.updateCalls = 0;
  vm.createContext(sandbox);
  vm.runInContext(seekSource, sandbox, { filename: '04-progress-seek.js' });
  return sandbox;
}

test('hover preview shows mouse-position time in time-display without touching fill', () => {
  const sandbox = createSandbox();
  // 鼠标在进度条 50% 处（clientX = 100 + 100 = 200）→ 时间应为 100s（1:40）
  const ok = sandbox.previewProgressHoverTime({ clientX: 200 });
  assert.equal(ok, true);
  assert.equal(sandbox.progressHoverState.active, true);
  assert.equal(sandbox.timeDisplay.textContent, '1:40 / 3:20');
  assert.equal(sandbox.progressBar.classList.contains('progress-hovering'), true);
  // 进度条填充不应被 hover 修改（updatePlaybackProgressUi 在 hover 时跳过文本覆盖）
  sandbox.updatePlaybackProgressUi();
  assert.equal(sandbox.timeDisplay.textContent, '1:40 / 3:20', 'hover preview must not be overwritten by playback progress');
});

test('hover preview clamps to bar bounds', () => {
  const sandbox = createSandbox();
  // clientX 超出进度条右侧 → 钳制到 100%
  sandbox.previewProgressHoverTime({ clientX: 9999 });
  assert.equal(sandbox.timeDisplay.textContent, '3:20 / 3:20');
  // clientX 在进度条左侧 → 钳制到 0
  sandbox.previewProgressHoverTime({ clientX: 0 });
  assert.equal(sandbox.timeDisplay.textContent, '0:00 / 3:20');
});

test('clearProgressHoverPreview restores real playback time and removes class', () => {
  const sandbox = createSandbox();
  sandbox.previewProgressHoverTime({ clientX: 200 });
  assert.equal(sandbox.timeDisplay.textContent, '1:40 / 3:20');
  sandbox.clearProgressHoverPreview();
  assert.equal(sandbox.progressHoverState.active, false);
  assert.equal(sandbox.progressBar.classList.contains('progress-hovering'), false);
  // 清除后 updatePlaybackProgressUi 恢复真实播放进度（30s / 200s）
  sandbox.updatePlaybackProgressUi();
  assert.equal(sandbox.timeDisplay.textContent, '0:30 / 3:20');
});

test('hover preview is skipped while dragging', () => {
  const sandbox = createSandbox();
  sandbox.progressDragState.active = true;
  const ok = sandbox.previewProgressHoverTime({ clientX: 200 });
  assert.equal(ok, false, 'hover must not run during drag');
  assert.equal(sandbox.progressHoverState.active, false);
});

test('hover preview returns false without duration', () => {
  const sandbox = createSandbox();
  sandbox.getPlaybackDurationSeconds = () => 0;
  const ok = sandbox.previewProgressHoverTime({ clientX: 200 });
  assert.equal(ok, false);
});

test('progress bar binds hover enter/move/leave handlers', () => {
  assert.match(seekSource, /addEventListener\('pointerenter'/);
  assert.match(seekSource, /addEventListener\('pointermove', function \(e\) \{[\s\S]*?if \(progressDragState\.active\) return;[\s\S]*?previewProgressHoverTime\(e\)/);
  assert.match(seekSource, /addEventListener\('pointerleave'/);
});

test('hover preview functions exist and updatePlaybackProgressUi preserves hover text', () => {
  assert.match(seekSource, /function previewProgressHoverTime\s*\(/);
  assert.match(seekSource, /function clearProgressHoverPreview\s*\(/);
  assert.match(seekSource, /function progressHoverTimeFromEvent\s*\(/);
  assert.match(seekSource, /progressHoverState\.active[\s\S]{0,120}return;/);
});

test('hover preview updates the mouse-following tooltip with position time', () => {
  const sandbox = createSandbox();
  // 鼠标在进度条 25% 处（clientX = 100 + 50 = 150）→ 50s（0:50），--tip-x = 25%
  const ok = sandbox.previewProgressHoverTime({ clientX: 150 });
  assert.equal(ok, true);
  assert.equal(sandbox.tooltip.textContent, '0:50');
  assert.equal(sandbox.tooltip.styleProps['--tip-x'], '25%');
  // 50% 处 → 100s（1:40），--tip-x = 50%
  sandbox.previewProgressHoverTime({ clientX: 200 });
  assert.equal(sandbox.tooltip.textContent, '1:40');
  assert.equal(sandbox.tooltip.styleProps['--tip-x'], '50%');
});

test('progress bar HTML contains the tooltip element', () => {
  const htmlPath = path.join(appRoot, 'public', 'index.html');
  const htmlSource = fs.readFileSync(htmlPath, 'utf8');
  assert.match(htmlSource, /<div id="progress-tooltip" class="progress-tooltip"/);
  assert.match(htmlSource, /id="progress-bar"[\s\S]*?id="progress-tooltip"/);
});

test('CSS styles the tooltip and shows it while progress-hovering', () => {
  assert.match(cssSource, /#progress-tooltip \{/);
  assert.match(cssSource, /--tip-x/);
  assert.match(cssSource, /#progress-bar\.progress-hovering #progress-tooltip \{[\s\S]*?opacity: 1/);
});

test('CSS adds a progress-hovering visual state', () => {
  assert.match(cssSource, /#progress-bar\.progress-hovering/);
});

console.log('PASS tests/progress-hover-preview.test.js');
