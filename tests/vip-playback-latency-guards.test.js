// VIP 歌曲播放延迟守卫（回归）：
// 1) server.js 的汽水加密音频解密下载必须带超时并合并并发请求；
// 2) 渲染器对 LX 源解析必须有时限，超时后走内置音源通道。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');
const playbackSource = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'),
  'utf8'
);

test('server.js 汽水解密下载带超时上限（回归：CDN 挂起时 /api/audio 不再永远不响应）', () => {
  // 必须使用 fetchWithTimeout（有超时），而不是裸 fetch（无超时）
  assert.match(serverSource, /QISHUI_DECRYPT_FETCH_TIMEOUT_MS\s*=\s*\d+/);
  assert.match(serverSource, /const up = await fetchWithTimeout\(parsed\.cleanUrl/);
  // 不得回退为无超时的整文件下载
  assert.doesNotMatch(serverSource, /const up = await fetch\(parsed\.cleanUrl/);
});

test('server.js 汽水解密合并并发请求（回归：缓存未命中时多个 Range 请求重复下载整歌）', () => {
  assert.match(serverSource, /qishuiAudioDecryptInFlight\s*=\s*new Map\(\)/);
  assert.match(serverSource, /const pending = qishuiAudioDecryptInFlight\.get\(key\)/);
  assert.match(serverSource, /qishuiAudioDecryptInFlight\.delete\(key\)/);
});

test('渲染器 LX 源解析带总时限（回归：VIP 源慢/无响应时不再长时间转圈）', () => {
  assert.match(playbackSource, /IMPORT_RESOLVE_ATTEMPT_BUDGET_MS\s*=\s*9000/);
  assert.match(playbackSource, /IMPORT_RESOLVE_TOTAL_BUDGET_MS\s*=\s*12000/);
  assert.match(playbackSource, /USER_API_RESOLVE_TIMEOUT/);
  // 每次 resolveSongUrl 都必须经过超时包装
  assert.match(playbackSource, /await lxResolveAttempt\(/);
});
