// 会话失效 → loggedIn:false 映射回归测试
// 覆盖 QQ/酷狗/汽水登录状态归一化与歌单同步结果的会话失效识别，
// 防止"cookie 过期仍显示已登录、歌单同步静默失败"问题回归。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const loginSource = fs.readFileSync(
  path.join(appRoot, 'public/js/modules/08-account/02-login-status.js'),
  'utf8'
);
const shellSource = fs.readFileSync(
  path.join(appRoot, 'public/js/modules/06-lyrics/01-playlist-panel-shell.js'),
  'utf8'
);

function extractFunction(source, name, sandbox) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) {
      return vm.runInNewContext(`(${source.slice(start, i + 1)})`, sandbox || {});
    }
  }
  throw new Error(`Could not parse ${name}`);
}

test('QQ 登录状态：sessionExpired 必须降级为未登录并标记 stale', () => {
  const normalize = extractFunction(loginSource, 'normalizeQQLoginStatus');
  const expired = normalize({
    provider: 'qq',
    loggedIn: false,
    sessionExpired: true,
    stale: true,
    nickname: '用户',
    userId: 'u1',
    playbackKeyReady: true,
  });
  assert.equal(expired.loggedIn, false);
  assert.equal(expired.sessionExpired, true);
  assert.equal(expired.stale, true);
  // 兜底：即使服务端误报 loggedIn:true，sessionExpired 也必须按掉登录处理
  const inconsistent = normalize({
    provider: 'qq',
    loggedIn: true,
    sessionExpired: true,
    nickname: '用户',
    userId: 'u1',
  });
  assert.equal(inconsistent.loggedIn, false);
});

test('QQ 登录状态：正常会话保持已登录', () => {
  const normalize = extractFunction(loginSource, 'normalizeQQLoginStatus');
  const ok = normalize({
    provider: 'qq',
    loggedIn: true,
    nickname: '用户',
    userId: 'u1',
    playbackKeyReady: true,
  });
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.sessionExpired, false);
});

test('酷狗登录状态：reauthRequired / sessionExpired 必须降级为未登录', () => {
  const normalize = extractFunction(loginSource, 'normalizeKugouLoginStatus', {
    providerVipLevel: () => 'none',
  });
  const expired = normalize({
    provider: 'kugou',
    loggedIn: false,
    reauthRequired: true,
    sessionExpired: true,
    stale: true,
    nickname: '酷狗用户',
    userId: 'k1',
  });
  assert.equal(expired.loggedIn, false);
  assert.equal(expired.reauthRequired, true);
  assert.equal(expired.sessionExpired, true);
  assert.equal(expired.stale, true);
  // 正常登录（需要 providerVipLevel 注入）
  const ok = normalize({
    provider: 'kugou',
    loggedIn: true,
    nickname: '酷狗用户',
    userId: 'k1',
    playbackReady: true,
  });
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.reauthRequired, false);
});

test('汽水登录状态：sessionExpired 必须降级为未登录', () => {
  const normalize = extractFunction(loginSource, 'normalizeQishuiLoginStatus');
  const expired = normalize({
    provider: 'qishui',
    loggedIn: false,
    webSession: false,
    configured: true,
    sessionExpired: true,
    stale: true,
  });
  assert.equal(expired.loggedIn, false);
  assert.equal(expired.sessionExpired, true);
  assert.equal(expired.stale, true);
  // 正常 webSession 保持已登录
  const ok = normalize({
    provider: 'qishui',
    loggedIn: true,
    webSession: true,
    configured: true,
    cookieReady: true,
    capabilities: { playableUrl: true },
  });
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.sessionExpired, false);
});

test('汽水服务端：401/403 会话失效约定覆盖 HTTP 层与业务码层', () => {
  const qishuiSource = fs.readFileSync(path.join(appRoot, 'qishui-api.js'), 'utf8');
  // 库拉取时 401/403 → sessionExpired 标记（与 qishuiWebRequestJson 既有 break 约定一致）
  assert.match(qishuiSource, /if \(err && \(err\.statusCode === 401 \|\| err\.statusCode === 403\)\) sessionExpired = true;/);
  // HTTP 层（requestText）与业务 status_code（qishuiPcStatusError）都写入 err.statusCode
  assert.match(qishuiSource, /err\.statusCode = response\.statusCode;/);
  assert.match(qishuiSource, /err\.statusCode = code;/);
  // 登录状态接口必须把 sessionExpired 降级为登录失效
  assert.match(qishuiSource, /if \(library && library\.sessionExpired\)/);
});

test('歌单同步：loggedIn:false / reauthRequired 视为会话失效并清空该平台歌单', () => {
  const applyResult = extractFunction(shellSource, 'applyPlaylistCatalogSyncResult');
  const previous = [{ id: 'old', provider: 'kugou' }];

  const byReauth = applyResult(previous, {
    provider: 'kugou',
    loggedIn: false,
    reauthRequired: true,
    playlists: [],
    error: 'KG_SESSION_EXPIRED',
    message: '酷狗会话已失效，请重新登录',
  });
  assert.equal(byReauth.rows.length, 0);
  assert.equal(byReauth.synced, false);
  assert.equal(byReauth.sessionExpired, true);
  assert.equal(byReauth.error, '酷狗会话已失效，请重新登录');

  const byLoggedOut = applyResult(previous, {
    provider: 'qq',
    loggedIn: false,
    playlists: [],
  });
  assert.equal(byLoggedOut.rows.length, 0);
  assert.equal(byLoggedOut.synced, false);
  assert.equal(byLoggedOut.sessionExpired, true);

  // 普通失败（网络错误等）保留旧歌单、不标记会话失效
  const byError = applyResult(previous, {
    provider: 'kugou',
    loggedIn: true,
    playlists: [],
    error: 'KUGOU_PLAYLIST_FAILED',
  });
  assert.equal(byError.rows.length, previous.length);
  assert.equal(byError.synced, false);
  assert.equal(byError.sessionExpired, false);
});

test('歌单同步：正常响应仍视为成功', () => {
  const applyResult = extractFunction(shellSource, 'applyPlaylistCatalogSyncResult');
  const result = applyResult([], {
    provider: 'qq',
    loggedIn: true,
    playlists: [{ id: 'p1', name: '歌单' }],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'p1');
  assert.equal(result.synced, true);
});
