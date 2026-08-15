'use strict';

// 回归测试：第三方音源（UserApi）整体失败时的熔断。
//
// 覆盖 13-playback-start-audio.js 的 mineradioLxResolveImportedSong：
// 1) 连续多次解析全部失败（音源下线 / DNS 失效 / 超时）后打开熔断，
//    后续解析直接跳过 UserApi（不再每次空等最长 ~12s 预算）；
// 2) 冷却期过后熔断自动关闭，重新尝试 UserApi；
// 3) 任意一次成功都会重置失败计数，不会误伤恢复后的音源。

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
  '13-playback-start-audio.js',
);

function extractFunction(sourceText, functionName) {
  const start = sourceText.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `missing ${functionName} in playback start module`);
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
  const calls = { resolve: 0, findMatch: 0 };
  let resolveBehavior = options.resolveBehavior || 'reject';
  const fakeDate = {
    now() { return fakeNow; },
  };
  let fakeNow = 1_000_000;

  const context = vm.createContext({
    window: {
      mineradioUserApi: {
        resolveSongUrl() {
          calls.resolve += 1;
          if (resolveBehavior === 'resolve') return Promise.resolve({ url: 'https://ok.example/audio.mp3', level: 'exhigh' });
          return Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND api.huibq.com'), { code: 'ENOTFOUND' }));
        },
      },
    },
    findControlSourceMatchResult() {
      calls.findMatch += 1;
      return Promise.reject(new Error('no control source match'));
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date: fakeDate,
    Math,
    Number,
    Promise,
  });

  const sourceText = fs.readFileSync(modulePath, 'utf8');
  const executableSource = [
    'var MINERADIO_LX_USERAPI_FAIL_THRESHOLD = 2;',
    'var MINERADIO_LX_USERAPI_FAIL_COOLDOWN_MS = 4 * 60 * 1000;',
    'var mineradioLxUserApiFailStreak = 0;',
    'var mineradioLxUserApiFailStreakStartAt = 0;',
    ...['mineradioLxUserApiCircuitOpen', 'mineradioLxUserApiMarkSuccess', 'mineradioLxUserApiMarkFailure', 'mineradioLxResolveImportedSong']
      .map((name) => extractFunction(sourceText, name)),
  ].join('\n\n');
  vm.runInContext(executableSource, context, { filename: modulePath });

  return {
    resolve(song, quality) {
      return context.mineradioLxResolveImportedSong(song, quality);
    },
    setResolveBehavior(behavior) { resolveBehavior = behavior; },
    advanceCooldown() { fakeNow += 4 * 60 * 1000 + 1; },
    get calls() { return calls; },
    get streak() { return context.mineradioLxUserApiFailStreak; },
    get circuitOpen() { return context.mineradioLxUserApiCircuitOpen(); },
  };
}

async function testCircuitOpensAfterRepeatedTotalFailures() {
  const harness = makeHarness({ resolveBehavior: 'reject' });
  const song = { provider: 'netease', id: '1', name: 'A', artist: 'B' };

  const first = await harness.resolve(song, 'exhigh');
  assert.strictEqual(first, null, 'first all-failed resolve returns null');
  assert.strictEqual(harness.calls.resolve, 1, 'first resolve hit the UserApi once');

  const second = await harness.resolve(song, 'exhigh');
  assert.strictEqual(second, null, 'second all-failed resolve returns null');
  assert.strictEqual(harness.calls.resolve, 2, 'second resolve hit the UserApi once');
  assert.strictEqual(harness.circuitOpen, true, 'two consecutive total failures must open the circuit');

  const third = await harness.resolve(song, 'exhigh');
  assert.strictEqual(third, null, 'circuit-open resolve still returns null (built-in fallback)');
  assert.strictEqual(harness.calls.resolve, 2, 'circuit-open resolve must NOT call the UserApi again');
}

async function testCooldownExpiryRearmsTheCircuit() {
  const harness = makeHarness({ resolveBehavior: 'reject' });
  const song = { provider: 'qq', id: '2', name: 'B', artist: 'C' };

  await harness.resolve(song, 'standard');
  await harness.resolve(song, 'standard');
  assert.strictEqual(harness.circuitOpen, true, 'circuit must be open after two failures');
  assert.strictEqual(harness.calls.resolve, 2);

  harness.advanceCooldown();
  assert.strictEqual(harness.circuitOpen, false, 'circuit must close after the cooldown window');

  await harness.resolve(song, 'standard');
  assert.strictEqual(harness.calls.resolve, 3, 're-armed circuit must try the UserApi again');
}

async function testSuccessResetsTheFailureStreak() {
  const harness = makeHarness({ resolveBehavior: 'reject' });
  const song = { provider: 'kugou', id: '3', name: 'C', artist: 'D' };

  await harness.resolve(song, 'standard');
  await harness.resolve(song, 'standard');
  assert.strictEqual(harness.circuitOpen, true);

  // 音源恢复通常发生在冷却期之后：先让熔断关闭，再验证成功会重置失败计数。
  harness.advanceCooldown();
  assert.strictEqual(harness.circuitOpen, false, 'cooldown must elapse before the retry');

  harness.setResolveBehavior('resolve');
  const ok = await harness.resolve(song, 'standard');
  assert.ok(ok && ok.url, 'a healthy resolve returns the URL');
  assert.strictEqual(harness.streak, 0, 'a success must reset the failure streak');

  harness.setResolveBehavior('reject');
  await harness.resolve(song, 'standard');
  assert.strictEqual(harness.circuitOpen, false, 'single failure after a reset must not open the circuit');
  assert.strictEqual(harness.calls.resolve, 4, 'success retry + post-reset failing call both hit the UserApi');
}

async function run() {
  await testCircuitOpensAfterRepeatedTotalFailures();
  await testCooldownExpiryRearmsTheCircuit();
  await testSuccessResetsTheFailureStreak();
  console.log('OK playback-userapi-circuit-breaker');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
