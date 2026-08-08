// 回归测试：歌词源跟随实际播放源（换源 / 网易云站内换录音 sourceMatch）
// 运行：node tests/lyric-source-follow-playback.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const lyricsPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const lyricsText = fs.readFileSync(lyricsPath, 'utf8');

// 与 07-search.js:445 一致的 songProviderKey 桩
function stubSongProviderKey(song) {
  if (song && (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri)) return 'spotify';
  if (song && (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq')) return 'qq';
  if (song && (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui')) return 'qishui';
  if (song && (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash)) return 'kugou';
  return 'netease';
}

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
    songProviderKey: stubSongProviderKey,
    playbackDurationFromSong: () => '',
    trackSwitchToken: 7,
    document: { readyState: 'loading', addEventListener: () => {}, getElementById: () => ({ textContent: '' }) },
    window: {},
    apiJson: async () => { sandbox.apiJsonCalls = (sandbox.apiJsonCalls || 0) + 1; return { lyric: '[00:01]x' }; },
    cloneLyricLines: (x) => x,
    setOriginalLyricsState: () => {},
    applyPreferredLyricsForCurrent: () => {},
    scheduleNeteaseLyricTranslationFallback: () => {},
    writePersistentLyricCache: () => {},
    updateCustomLyricControls: () => { sandbox.resetCalls = (sandbox.resetCalls || 0) + 1; },
    invalidateStageLyricPayloadForNewLyrics: () => {},
    clearStageLyrics: () => {},
    cancelPendingTrackFallbackLyrics: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(lyricsText, sandbox, { filename: '00-lyrics-fetch-parse.js' });
  return sandbox;
}

const S = createSandbox();

// 1. 普通网易云歌
{
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  assert.strictEqual(S.lyricProviderForSong(song), 'netease');
  assert.strictEqual(S.lyricEndpointForSong(song), '/api/lyric?id=123');
  assert.strictEqual(S.persistentLyricCacheKey(song), 'lyrics-v2|netease|123|A|B');
}
// 2. 网易云 sourceMatch 换录音：歌词跟随实际播放录音 id
{
  const song = { id: '123', resolvedNeteaseId: '456', name: 'A', artist: 'B', provider: 'netease' };
  assert.strictEqual(S.lyricProviderForSong(song), 'netease');
  assert.strictEqual(S.lyricEndpointForSong(song), '/api/lyric?id=456');
  assert.strictEqual(S.lyricPlaybackSourceKey(song), 'netease|456');
}
// 3. QQ 歌
{
  const song = { mid: 'M001', name: 'A', artist: 'B', provider: 'qq' };
  assert.strictEqual(S.lyricProviderForSong(song), 'qq');
  assert.strictEqual(S.lyricEndpointForSong(song), '/api/qq/lyric?mid=M001&id=');
}
// 4. 实际播放平台标记优先（换源后 song 残留或 LX 解析标记）
{
  const song = { id: '123', mid: 'M9', name: 'A', artist: 'B', provider: 'netease', resolvedPlaybackProvider: 'qq' };
  assert.strictEqual(S.lyricProviderForSong(song), 'qq');
  assert.ok(S.lyricEndpointForSong(song).indexOf('/api/qq/lyric?mid=M9') === 0);
}
// 5. playbackSource 非白名单（netease-same-track）不误切
{
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease', playbackSource: 'netease-same-track' };
  assert.strictEqual(S.lyricProviderForSong(song), 'netease');
}
// 6. playbackSource 为已知平台时跟随
{
  const song = { id: '123', hash: 'H1', name: 'A', artist: 'B', provider: 'netease', playbackSource: 'kugou' };
  assert.strictEqual(S.lyricProviderForSong(song), 'kugou');
  assert.strictEqual(S.lyricPlaybackSourceKey(song), 'kugou|H1');
}
// 7. 无 provider 标记但有 hash → kugou
{
  const song = { hash: 'H1', name: 'A', artist: 'B' };
  assert.strictEqual(S.lyricProviderForSong(song), 'kugou');
}

// 8. 防串台：请求发起后歌词身份变化 → 丢弃过期结果（sourceMatch 同 token 竞态）
{
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  // 响应返回时身份已变为 netease|456（sourceMatch 换录音），而请求是 netease|123 发起的
  song.resolvedNeteaseId = '456';
  const stale = S.applyFetchedLyricResponse(song, 7, { lyric: '[00:01]旧' }, { persist: false, expectSourceKey: 'netease|123' });
  assert.strictEqual(stale, null, '身份变化后过期结果应被丢弃');
}
// 9. 身份一致 → 正常应用
{
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  const state = S.applyFetchedLyricResponse(song, 7, { lyric: '[00:01]x' }, { persist: false, expectSourceKey: 'netease|123' });
  assert.ok(state && state.usableLyric, '身份一致时应正常应用');
}
// 10. ensureLyricMatchesResolvedSource：身份变化 → 重置并重新取词
{
  S.resetCalls = 0;
  S.apiJsonCalls = 0;
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  song.__lyricFetchedSourceKey = 'netease|123'; // 早期 fetch 记录的身份
  song.resolvedNeteaseId = '456'; // 播放解析后实际身份
  S.ensureLyricMatchesResolvedSource(song, 7);
  assert.ok(S.resetCalls >= 1, '身份变化时应重置歌词');
  assert.strictEqual(song.__lyricFetchedSourceKey, 'netease|456', '重新取词后身份应更新');
}
// 11. ensureLyricMatchesResolvedSource：身份一致 → 不重复取词
{
  S.resetCalls = 0;
  S.apiJsonCalls = 0;
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  song.__lyricFetchedSourceKey = 'netease|123';
  S.ensureLyricMatchesResolvedSource(song, 7);
  assert.strictEqual(S.resetCalls, 0, '身份一致不应重置');
  assert.strictEqual(S.apiJsonCalls, 0, '身份一致不应重复请求');
}
// 12. 本地歌跳过
{
  S.apiJsonCalls = 0;
  const song = { localKey: 'L1', type: 'local', name: 'A' };
  S.ensureLyricMatchesResolvedSource(song, 7);
  assert.strictEqual(S.apiJsonCalls, 0, '本地歌应跳过');
}
// 13. 异步竞态回归：早期慢请求晚到，重取后身份变化 → 旧结果被丢弃且不会写入
{
  S.apiJsonCalls = 0;
  const song = { id: '123', name: 'A', artist: 'B', provider: 'netease' };
  song.__lyricFetchedSourceKey = 'netease|123';
  song.resolvedNeteaseId = '456';
  S.ensureLyricMatchesResolvedSource(song, 7); // 触发重取，__lyricFetchedSourceKey -> netease|456
  const late = S.applyFetchedLyricResponse(song, 7, { lyric: '[00:01]旧平台' }, { persist: false, expectSourceKey: 'netease|123' });
  assert.strictEqual(late, null, '早期慢请求晚到应被丢弃');
}

console.log('PASS tests/lyric-source-follow-playback.test.js');
