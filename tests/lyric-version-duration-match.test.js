// 回归测试：歌词"版本/录音不匹配"导致的错位修复
// 1) 酷狗歌词候选按时长匹配（pickKugouLyricCandidateByDuration）
// 2) 歌词时间轴 vs 音频时长不符提示（maybeWarnLyricTimelineMismatch）
// 运行：node tests/lyric-version-duration-match.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');

// ---------- 1. 酷狗歌词候选按时长匹配 ----------
const kugou = require(path.join(appRoot, 'kugou-api.js'));
const pick = kugou._test.pickKugouLyricCandidateByDuration;

{
  const candidates = [
    { id: 'live', duration: 320 },   // Live 版 5:20
    { id: 'studio', duration: 245 }, // 录音室 4:05
    { id: 'remix', duration: 180 },
  ];
  const best = pick(candidates, 242); // 所播音频 4:02
  assert.strictEqual(best.id, 'studio', '应选时长最接近的候选（242 vs 245）');
}
{
  const candidates = [
    { id: 'a', duration_ms: 240000 }, // 240s
    { id: 'b', duration_ms: 300000 }, // 300s
  ];
  const best = pick(candidates, 238);
  assert.strictEqual(best.id, 'a', 'duration_ms 字段也应生效');
}
{
  // duration 字段可能为毫秒（>1000 归一化为秒）
  const candidates = [
    { id: 'x', duration: 320000 }, // 320s
    { id: 'y', duration: 245000 }, // 245s
  ];
  const best = pick(candidates, 242);
  assert.strictEqual(best.id, 'y', 'duration 为毫秒时应归一化后匹配');
}
{
  // durationSec 恒为秒
  const candidates = [
    { id: 'x', durationSec: 320 },
    { id: 'y', durationSec: 245 },
  ];
  const best = pick(candidates, 242);
  assert.strictEqual(best.id, 'y', 'durationSec 秒值匹配');
}
{
  // 无时长信息的候选：保留第一条兜底（原行为）
  const candidates = [{ id: 'x' }, { id: 'y' }];
  assert.strictEqual(pick(candidates, 240).id, 'x', '无时长时回退第一条');
}
{
  // targetSec 未知（0）：回退第一条
  const candidates = [{ id: 'x', duration: 100 }, { id: 'y', duration: 300 }];
  assert.strictEqual(pick(candidates, 0).id, 'x', '目标时长未知时回退第一条');
}
{
  // 空数组
  assert.strictEqual(pick([], 240), null);
}

// ---------- 2. 歌词时间轴 vs 音频时长不符提示 ----------
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
    songProviderKey: (song) => (song && song.provider) || 'netease',
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
const notices = [];
S.showSourceFallbackNotice = (title, body) => notices.push({ title, body });
S.getPlaybackDurationSeconds = () => 240; // 音频 4:00
S.playbackDurationFromSong = () => 0; // 兜底不用

// 版本明显不符：歌词最后一行在 2:30 结束（Live/翻唱短版本），音频 4:00
{
  notices.length = 0;
  const state = S.parseLyricResponseToOriginalState({ provider: 'netease', name: 'A' }, {
    lyric: '[00:10.00]第一句\n[02:20.00]最后一句',
  });
  S.maybeWarnLyricTimelineMismatch({ provider: 'netease', id: '1', name: 'A', artist: 'B' }, state);
  assert.strictEqual(notices.length, 1, '版本明显不符应提示');
  assert.ok(/版本可能不匹配/.test(notices[0].title), '提示标题');
  assert.ok(/约 \d+s/.test(notices[0].body), '提示包含偏差秒数');
}
// 偏差小（正常歌曲）：不提示
{
  notices.length = 0;
  const state = S.parseLyricResponseToOriginalState({ provider: 'netease', name: 'A' }, {
    lyric: '[00:10.00]第一句\n[03:50.00]最后一句', // 结束约 3:55，音频 4:00
  });
  S.maybeWarnLyricTimelineMismatch({ provider: 'netease', id: '2', name: 'A', artist: 'B' }, state);
  assert.strictEqual(notices.length, 0, '正常偏差不应提示');
}
// 同一首歌只提示一次
{
  notices.length = 0;
  const state = S.parseLyricResponseToOriginalState({ provider: 'netease', name: 'A' }, {
    lyric: '[00:10.00]第一句\n[02:20.00]最后一句',
  });
  const song = { provider: 'netease', id: '3', name: 'A', artist: 'B' };
  S.maybeWarnLyricTimelineMismatch(song, state);
  S.maybeWarnLyricTimelineMismatch(song, state);
  assert.strictEqual(notices.length, 1, '同一首歌只提示一次');
}
// 时长未知 / 过短：不提示
{
  notices.length = 0;
  S.getPlaybackDurationSeconds = () => 0; // 未知
  const state = S.parseLyricResponseToOriginalState({ provider: 'netease', name: 'A' }, {
    lyric: '[00:10.00]第一句\n[02:20.00]最后一句',
  });
  S.maybeWarnLyricTimelineMismatch({ provider: 'netease', id: '4', name: 'A', artist: 'B' }, state);
  assert.strictEqual(notices.length, 0, '时长未知不应提示');
  S.getPlaybackDurationSeconds = () => 240;
}

console.log('PASS tests/lyric-version-duration-match.test.js');
