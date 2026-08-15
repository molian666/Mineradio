'use strict';

// 回归测试：暂停后点击继续播放的"加载时间长 / 无响应"问题。
//
// 覆盖 14-player-controls.js 的恢复路径：
// 1) 缓冲仍有效时，快速恢复优先且瞬时完成，绝不无条件进入网络重新取链；
// 2) 快速恢复在短预算（RESUME_FAST_PLAY_TIMEOUT_MS）内未启动时，直接转入
//    重新取链通道（带加载反馈），而不是对同一元素再空等一次 9 秒 play()；
// 3) 长时间暂停后恢复仍走旧链接失效的重新取链路径（long-pause-stale-source）；
// 4) 本地文件等无法重新取链时，对原元素做一次带短超时的直接播放兜底。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(
  __dirname,
  '..',
  'public',
  'js',
  'modules',
  '05-playback',
  '14-player-controls.js',
);

function extractFunction(sourceText, functionName) {
  const asyncStart = sourceText.indexOf(`async function ${functionName}(`);
  const plainStart = sourceText.indexOf(`function ${functionName}(`);
  assert.notEqual(plainStart, -1, `missing ${functionName} in player controls module`);
  const start = asyncStart >= 0 && asyncStart < plainStart ? asyncStart : plainStart;
  const bodyStart = sourceText.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `missing body for ${functionName}`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${functionName}`);
}

function makeHarness(options = {}) {
  const timers = [];
  const calls = {
    play: 0,
    pause: 0,
    recovery: 0,
    recoveryReasons: [],
    showLoading: 0,
    hideLoading: 0,
    startedReasons: [],
  };
  const refreshable = options.refreshable == null ? true : !!options.refreshable;
  const pausedLongEnough = !!options.pausedLongEnough;
  const hangPlayCalls = Math.max(0, Number(options.hangPlayCalls) || 0);
  const recoveryResult = options.recoveryResult == null ? true : options.recoveryResult;

  const media = {
    src: 'https://local.invalid/audio?id=t1',
    currentSrc: 'https://local.invalid/audio?id=t1',
    currentTime: 12,
    duration: 240,
    readyState: 4,
    paused: true,
    ended: false,
    networkState: 2,
    NETWORK_NO_SOURCE: 3,
    __mineradioQueueItemKey: 't1',
    play() {
      calls.play += 1;
      if (hangPlayCalls && calls.play <= hangPlayCalls) {
        return new Promise(function () { /* 挂起，模拟旧流已不可用 */ });
      }
      return Promise.resolve();
    },
    pause() {
      calls.pause += 1;
      this.paused = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const context = vm.createContext({
    audio: media,
    trackSwitchToken: 7,
    playing: false,
    playbackResumeRecovery: {
      serial: 0,
      pending: false,
      lastAttemptAt: 0,
      lastReason: '',
      pausedAt: Date.now() - 5 * 60 * 1000,
      pausedSongKey: 't1',
      pausedSrc: media.src,
      pausedPosition: 12,
      freshUrlSongKey: '',
      freshUrlAttemptCount: 0,
      timerIds: [],
    },
    playQueue: [{ key: 't1', provider: 'qq', id: '1', name: 'A', artist: 'B' }],
    currentIdx: 0,
    queueItemKey(song) { return song && song.key; },
    songProviderKey() { return 'qq'; },

    // ---- 依赖桩 ----
    showLoading() { calls.showLoading += 1; },
    hideLoading() { calls.hideLoading += 1; },
    canRefreshCurrentPlaybackUrlForResume() { return refreshable; },
    playbackResumePausedLongEnough() { return pausedLongEnough; },
    currentResumeSeconds(fallback) { return Math.max(0, Number(fallback) || 0); },
    recoverCurrentTrackPlaybackFromFreshUrl(reason) {
      calls.recovery += 1;
      calls.recoveryReasons.push(reason || '');
      return Promise.resolve(recoveryResult);
    },
    audioGraphHealthy() { return true; },
    initAudio() { return false; },
    preparePlaybackFadeIn() {},
    startPlaybackFadeIn() {},
    restorePlaybackGain() {},
    applyAudioOutputDevice() { return Promise.resolve(); },
    ensurePlaybackAudioGraph() { return Promise.resolve(true); },
    ensureAudiblePlaybackGain() {},
    switchPlaybackVisualToEmily() {},
    setPlayIcon() {},
    markStageLyricsPlaybackResume() {},
    primeCinemaAfterTrackStart() {},
    resetPlaybackFreshUrlRecoveryBudget() {},
    schedulePlaybackAnalyserRecovery() {},
    schedulePlaybackStallRecovery() {},
    forcePlaybackControlsInteractive() {},
    retryTrackSwitchAudioPlayOnce() { return Promise.resolve(null); },
    showToast() {},

    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) {
      const entry = { callback, delay, cancelled: false, ran: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cancelled = true;
    },
    isFinite,
    Math,
    Number,
    Promise,
  });

  const sourceText = fs.readFileSync(modulePath, 'utf8');
  const functionNames = [
    'isSameAudioPlaybackTarget',
    'playbackAttemptStillCurrent',
    'awaitMediaPlayWithTimeout',
    'playbackMediaMatchesCurrentQueueItem',
    'canResumePausedAudioFast',
    'schedulePausedAudioResumeMaintenance',
    'resumePausedAudioFast',
    'completeAudioPlayStart',
    'attemptAudioPlay',
  ];
  const executableSource = [
    'var RESUME_FAST_PLAY_TIMEOUT_MS = 60;',
    'var AUDIO_PLAY_REQUEST_TIMEOUT_MS = 9000;',
    ...functionNames.map((name) => extractFunction(sourceText, name)),
  ].join('\n\n');
  vm.runInContext(executableSource, context, { filename: modulePath });

  const originalComplete = context.completeAudioPlayStart;
  context.completeAudioPlayStart = async function observedComplete(opts, reason, media, token) {
    calls.startedReasons.push(reason || '');
    return originalComplete(opts, reason, media, token);
  };

  function runEarliestTimer() {
    const entry = timers
      .filter((candidate) => !candidate.cancelled && !candidate.ran)
      .sort((left, right) => left.delay - right.delay)[0];
    assert.ok(entry, 'expected a queued resume timeout timer');
    entry.ran = true;
    entry.callback();
  }

  return { context, media, calls, runEarliestTimer, timers };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testFastResumeSucceedsWithoutRecovery() {
  const { context, calls } = makeHarness({ hangPlayCalls: 0 });
  const result = await context.attemptAudioPlay({ manual: true });

  assert.strictEqual(result, true, 'buffered pause must resume instantly via the fast path');
  assert.strictEqual(calls.play, 1, 'fast resume must be the only play() attempt');
  assert.strictEqual(calls.recovery, 0, 'fast resume must not trigger a network re-resolution');
  assert.strictEqual(calls.showLoading, 1, 'manual resume must give immediate loading feedback');
  assert.strictEqual(calls.hideLoading, 1, 'manual resume success must clear the loading feedback');
}

async function testFastResumeTimeoutFallsBackToFreshUrlRecovery() {
  const { context, calls, runEarliestTimer } = makeHarness({ hangPlayCalls: 1 });

  const pending = context.attemptAudioPlay({ manual: true });
  await tick();
  // 快速恢复的 play() 挂起：只应出现一次 play() 等待（短预算），随后立即进入
  // 重新取链，而不是再对同一元素发起第二次长超时 play()。
  assert.strictEqual(calls.play, 1, 'the fast attempt must be the only play() before recovery');
  runEarliestTimer();

  const result = await pending;
  assert.strictEqual(result, true, 'stalled fast resume must fall back to fresh-URL recovery');
  assert.strictEqual(calls.recovery, 1, 'stalled fast resume must trigger exactly one recovery');
  assert.deepStrictEqual(calls.recoveryReasons, ['manual-resume-stalled']);
  assert.strictEqual(calls.play, 1, 'recovery must replace the old element instead of retrying play() on it');
  assert.strictEqual(calls.showLoading, 1, 'loading feedback must be shown while resuming');
}

async function testLongPauseUsesStaleSourceRecoveryLabel() {
  const { context, calls, runEarliestTimer } = makeHarness({ hangPlayCalls: 1, pausedLongEnough: true });

  const pending = context.attemptAudioPlay({ manual: true });
  await tick();
  runEarliestTimer();

  const result = await pending;
  assert.strictEqual(result, true);
  assert.deepStrictEqual(calls.recoveryReasons, ['long-pause-stale-source']);
}

async function testUnrefreshableSongUsesSingleDirectResumeAttempt() {
  // 本地文件等无法重新取链：快速恢复失败后，对原元素做一次带短超时的直接播放。
  const { context, calls, runEarliestTimer } = makeHarness({ hangPlayCalls: 1, refreshable: false });

  const pending = context.attemptAudioPlay({ manual: true });
  await tick();
  runEarliestTimer();

  const result = await pending;
  assert.strictEqual(result, true, 'local song direct resume must start playback');
  assert.strictEqual(calls.recovery, 0, 'unrefreshable song must not attempt a fresh-URL recovery');
  assert.strictEqual(calls.play, 2, 'fast attempt + one direct resume attempt on the same element');
  assert.deepStrictEqual(calls.startedReasons, ['manual-resume-direct-started']);
  assert.strictEqual(calls.hideLoading, 1);
}

function testTrackSwitchStallRecoveryAllowedForAllProviders() {
  // 回归：非汽水平台的切歌/新歌启动停滞（"显示播放中但无声无进度"）也必须允许
  // 停滞恢复，否则第三方音源下线/链接失效时播放器会永远停在假播放状态。
  const sourceText = fs.readFileSync(modulePath, 'utf8');
  const fn = extractFunction(sourceText, 'trackSwitchStallRecoveryAllowed');
  const context = vm.createContext({
    audio: { src: 'https://local.invalid/a', paused: false, ended: false, seeking: false },
    playbackResumeProvider(song) { return (song && song.provider) || ''; },
    console: { warn() {} },
  });
  vm.runInContext(fn, context, { filename: modulePath });

  const qishui = { provider: 'qishui' };
  const netease = { provider: 'netease' };

  assert.strictEqual(
    context.trackSwitchStallRecoveryAllowed(netease, { trackSwitch: true }),
    true,
    'non-qishui track switch with live media must be allowed to schedule start-stall recovery',
  );
  assert.strictEqual(
    context.trackSwitchStallRecoveryAllowed(qishui, { trackSwitch: true }),
    true,
    'qishui track switch keeps its recovery allowance',
  );
  assert.strictEqual(
    context.trackSwitchStallRecoveryAllowed(netease, { resumeRecovery: true }),
    true,
    'resume recovery is always allowed',
  );
  assert.strictEqual(
    context.trackSwitchStallRecoveryAllowed(netease, {}),
    true,
    'event-driven stall recovery (error/stalled, no trackSwitch) stays allowed',
  );

  const pausedAudio = { src: 'https://local.invalid/a', paused: true, ended: false, seeking: false };
  const endedAudio = { src: 'https://local.invalid/a', paused: false, ended: true, seeking: false };
  const seekingAudio = { src: 'https://local.invalid/a', paused: false, ended: false, seeking: true };
  const originalAudio = context.audio;
  try {
    context.audio = pausedAudio;
    assert.strictEqual(context.trackSwitchStallRecoveryAllowed(netease, { trackSwitch: true }), false, 'paused media must not schedule recovery');
    context.audio = endedAudio;
    assert.strictEqual(context.trackSwitchStallRecoveryAllowed(netease, { trackSwitch: true }), false, 'ended media must not schedule recovery');
    context.audio = seekingAudio;
    assert.strictEqual(context.trackSwitchStallRecoveryAllowed(netease, { trackSwitch: true }), false, 'seeking media must not schedule recovery');
  } finally {
    context.audio = originalAudio;
  }
}

async function run() {
  await testFastResumeSucceedsWithoutRecovery();
  await testFastResumeTimeoutFallsBackToFreshUrlRecovery();
  await testLongPauseUsesStaleSourceRecoveryLabel();
  await testUnrefreshableSongUsesSingleDirectResumeAttempt();
  testTrackSwitchStallRecoveryAllowedForAllProviders();
  console.log('OK playback-resume-fast-path');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
