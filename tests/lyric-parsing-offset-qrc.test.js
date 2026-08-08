// 回归测试：歌词解析层同步 bug 修复
// 1) LRC [offset:] 标签整体平移；2) QQ QRC 逐字歌词接入（字词相对行首基准）；3) 网易云 YRC 绝对基准
// 运行：node tests/lyric-parsing-offset-qrc.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const lyricsPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const lyricsText = fs.readFileSync(lyricsPath, 'utf8');

function createSandbox() {
  const sandbox = {
    console,
    encodeURIComponent,
    decodeURIComponent,
    Math,
    Date,
    JSON,
    setTimeout,
    clearTimeout,
    Promise,
    document: { readyState: 'loading', addEventListener: () => {}, getElementById: () => ({ textContent: '' }) },
    window: {},
    cloneLyricLines: (x) => x,
    setOriginalLyricsState: () => {},
    applyPreferredLyricsForCurrent: () => {},
    scheduleNeteaseLyricTranslationFallback: () => {},
    writePersistentLyricCache: () => {},
    cancelPendingTrackFallbackLyrics: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(lyricsText, sandbox, { filename: '00-lyrics-fetch-parse.js' });
  return sandbox;
}

const S = createSandbox();

// 1. LRC [offset:500] 整体延后 0.5s
{
  const lines = S.parseLyricText('[offset:500]\n[00:01.00]第一行\n[00:05.00]第二行');
  assert.strictEqual(lines.length, 2);
  assert.ok(Math.abs(lines[0].t - 1.5) < 0.001, '第一行 t=1.5s（原 1.0s + 0.5s）');
  assert.ok(Math.abs(lines[1].t - 5.5) < 0.001, '第二行 t=5.5s');
}
// 2. LRC [offset:-500] 整体提前 0.5s，首行 clamp 到 0
{
  const lines = S.parseLyricText('[offset:-500]\n[00:00.20]开头\n[00:05.00]后面');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].t, 0, '首行 t 被 clamp 到 0');
  assert.ok(Math.abs(lines[1].t - 4.5) < 0.001, '第二行 t=4.5s（原 5.0s - 0.5s）');
}
// 3. 无 offset 的 LRC 不受影响
{
  const lines = S.parseLyricText('[00:01.00]第一行\n[00:05.00]第二行');
  assert.ok(Math.abs(lines[0].t - 1.0) < 0.001);
  assert.ok(Math.abs(lines[1].t - 5.0) < 0.001);
}
// 4. QQ QRC：字词偏移相对行首（旧启发式会在前几秒误判）
{
  // 行 start=2000ms，字词偏移 0/800/1800ms → 绝对 2.0s/2.8s/3.8s
  const lines = S.parseYrcText('[2000,2500](0,300,0)你(800,300,0)好(1800,300,0)呀', true);
  assert.strictEqual(lines.length, 1);
  assert.ok(Math.abs(lines[0].t - 2.0) < 0.001, '行 t=2.0s');
  assert.strictEqual(lines[0].words.length, 3, '解析出 3 个字词');
  assert.ok(Math.abs(lines[0].words[0].t - 2.0) < 0.001, '字1 t=2.0s');
  assert.ok(Math.abs(lines[0].words[1].t - 2.8) < 0.001, '字2 t=2.8s（旧逻辑误判为 0.8s）');
  assert.ok(Math.abs(lines[0].words[2].t - 3.8) < 0.001, '字3 t=3.8s（旧逻辑误判为 1.8s）');
}
// 5. 网易云 YRC：字词时间绝对毫秒（默认启发式路径）
{
  const lines = S.parseYrcText('[2000,2500](2000,300,0)你(2800,300,0)好(3800,300,0)呀');
  assert.ok(Math.abs(lines[0].words[0].t - 2.0) < 0.001);
  assert.ok(Math.abs(lines[0].words[1].t - 2.8) < 0.001);
  assert.ok(Math.abs(lines[0].words[2].t - 3.8) < 0.001);
}
// 6. YRC 带 [offset:] 时行与字词都平移
{
  const lines = S.parseYrcText('[offset:1000]\n[2000,2500](2000,300,0)你(2800,300,0)好');
  assert.ok(Math.abs(lines[0].t - 3.0) < 0.001, '行 t=3.0s（2.0s+1.0s）');
  assert.ok(Math.abs(lines[0].words[0].t - 3.0) < 0.001, '字1 t=3.0s');
  assert.ok(Math.abs(lines[0].words[1].t - 3.8) < 0.001, '字2 t=3.8s');
}
// 7. parseLyricResponseToOriginalState：QQ qrc 被解析出逐字卡拉 OK
{
  const state = S.parseLyricResponseToOriginalState({ provider: 'qq', name: 'A' }, {
    lyric: '[00:01.00]你好',
    qrc: '[1000,1500](0,300,0)你(800,300,0)好',
  });
  assert.strictEqual(state.hasNativeKaraoke, true, 'QQ qrc 应产生逐字卡拉 OK');
  assert.strictEqual(state.timingSource, 'yrc-word');
  assert.strictEqual(state.lines.length, 1);
  assert.ok(Math.abs(state.lines[0].words[1].t - 1.8) < 0.001, 'qrc 字词按相对行首解析');
}
// 8. parseLyricResponseToOriginalState：网易云 yrc 绝对基准
{
  const state = S.parseLyricResponseToOriginalState({ provider: 'netease', name: 'A' }, {
    lyric: '[00:01.00]你好',
    yrc: '[1000,1500](1000,300,0)你(1800,300,0)好',
  });
  assert.strictEqual(state.hasNativeKaraoke, true);
  assert.ok(Math.abs(state.lines[0].words[1].t - 1.8) < 0.001);
}
// 9. mergeInlineLyricResponseForSong：song.qrc 进 response.qrc，不污染 yrc
{
  const merged = S.mergeInlineLyricResponseForSong({ provider: 'qq', name: 'A', qrc: '[1000,500](0,200,0)字' }, { lyric: '[00:01.00]字' });
  assert.strictEqual(merged.qrc, '[1000,500](0,200,0)字', 'song.qrc 保留在 response.qrc');
  assert.ok(!merged.yrc, 'qrc 不应被塞进 yrc');
}
// 10. mergeInlineLyricResponseForSong：song.yrc 进 response.yrc
{
  const merged = S.mergeInlineLyricResponseForSong({ provider: 'netease', name: 'A', yrc: '[1000,500](1000,200,0)字' }, { lyric: '[00:01.00]字' });
  assert.strictEqual(merged.yrc, '[1000,500](1000,200,0)字');
  assert.ok(!merged.qrc);
}

console.log('PASS tests/lyric-parsing-offset-qrc.test.js');
