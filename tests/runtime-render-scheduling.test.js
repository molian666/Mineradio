'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainLoopText = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '11-main-loop.js'),
  'utf8',
);
const frameSchedulerText = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '00-state', '10-frame-scheduler.js'),
  'utf8',
);

test('main loop distinguishes active playback, visible idle, and deep background', () => {
  assert.match(mainLoopText, /function mainLoopRuntimeMode\(/);
  assert.match(mainLoopText, /['"]active['"]/);
  assert.match(mainLoopText, /['"]visible-idle['"]/);
  assert.match(mainLoopText, /['"]deep-background['"]/);
  assert.match(mainLoopText, /function mainLoopVisibleIdleDelayMs\(/);
});

test('main loop keeps wake scheduling single-shot and clamps delayed gate work', () => {
  assert.match(mainLoopText, /function wakeMainLoopFromBackground\(/);
  assert.match(mainLoopText, /clearTimeout\(mainLoopBackgroundTimer\)/);
  assert.match(frameSchedulerText, /Math\.min\(gate\.pendingDt/);
  assert.match(mainLoopText, /mainLoopVisibleIdleDelayMs\(/);
});

test('active audio analysis remains guarded by a playing media element', () => {
  assert.match(mainLoopText, /if \(analyser && playing && audio && !audio\.paused\)/);
});
