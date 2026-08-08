'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const progressText = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'),
  'utf8',
);
const overlayText = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'),
  'utf8',
);

test('progress maintenance is owned by a lifecycle scheduler', () => {
  assert.match(progressText, /function scheduleProgressMaintenance\(/);
  assert.match(progressText, /function clearProgressMaintenance\(/);
  assert.doesNotMatch(progressText, /setInterval\([\s\S]{0,500},\s*200\)/);
  assert.match(progressText, /audio && !audio\.paused/);
});

test('desktop overlay health checks start only for enabled desktop features', () => {
  assert.match(overlayText, /function scheduleDesktopOverlayHealthCheck\(/);
  assert.match(overlayText, /function clearDesktopOverlayHealthCheck\(/);
  assert.doesNotMatch(overlayText, /setInterval\([\s\S]{0,500},\s*320\)/);
  assert.match(overlayText, /fx\.desktopLyrics \|\| fx\.wallpaperMode/);
});
