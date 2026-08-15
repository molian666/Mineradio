// 音源"测试"按钮守卫（回归）：
// 测试能校验源脚本初始化 + 用源自身的 search/musicUrl 做真实的取链与可播性探测；
// 非活动源的脚本内部请求必须按 generation 路由到测试会话，而不是活动会话。
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimePath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-main.js');
const storePath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-store.js');
const { createUserApiStore } = require(storePath);
const { runUserApiSourceProbe, resolveRequestSession, actionHas, registerUserApiIpc } = require(runtimePath);

function fakeSession(requestHandler, overrides = {}) {
  return Object.assign({
    sourceId: 'test-source',
    generation: 7,
    disposed: false,
    controllers: new Set(),
    requestControllers: new Map(),
    requestSequence: 0,
    pendingRequests: new Map(),
    requestHandler,
    lastWindowDiagnostic: '',
    inited: { sources: [{ source: 'wy', name: '网易云', qualitys: ['128k', '320k', 'flac'], actions: ['search', 'musicUrl'] }] },
  }, overrides);
}

function startAudioServer(durationSec) {
  const total = 1024 * 1024;
  const first = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(total - 3, 0x50)]);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(total),
      'x-audio-duration': String(durationSec),
    });
    res.end(first);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('resolveRequestSession 按 generation 路由到测试会话（不影响活动会话）', () => {
  const active = { sourceId: 'active', generation: 1, disposed: false };
  const testing = { sourceId: 'test', generation: 9, disposed: false };
  const disposed = { sourceId: 'old', generation: 3, disposed: true };
  const sessions = [active, testing, disposed];
  assert.equal(resolveRequestSession({ generation: 9 }, sessions, active), testing);
  assert.equal(resolveRequestSession({ generation: 3 }, sessions, active), active, '已释放会话的请求回退到活动会话');
  assert.equal(resolveRequestSession({ url: 'x' }, sessions, active), active, '无 generation 请求走活动会话');
  assert.equal(resolveRequestSession({ generation: 9 }, sessions, null), testing);
});

test('actionHas 兼容字符串与对象两种 actions 声明', () => {
  assert.equal(actionHas(['search', 'musicUrl'], 'musicUrl'), true);
  assert.equal(actionHas([{ type: 'search' }, { type: 'musicUrl', name: '取链' }], 'musicUrl'), true);
  assert.equal(actionHas(['search'], 'musicUrl'), false);
  assert.equal(actionHas(null, 'musicUrl'), false);
});

test('probe 成功：search 找测试曲 → musicUrl 取链 → 可完整播放', async () => {
  const audioServer = await startAudioServer(269);
  const audioPort = audioServer.address().port;
  try {
    const session = fakeSession(async (payload) => {
      if (payload.action === 'search') {
        return { isEnd: true, songs: [{ name: '晴天', singer: '周杰伦', songmid: 'TESTMID', strMediaMid: 'TESTMID', interval: 269 }] };
      }
      if (payload.action === 'musicUrl') {
        return { url: `http://127.0.0.1:${audioPort}/test.mp3` };
      }
      throw new Error('unknown action ' + payload.action);
    });
    const result = await runUserApiSourceProbe(session, { deadline: Date.now() + 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].provider, 'wy');
    assert.equal(result.checks[0].completeness, 'full');
    assert.match(result.summary, /歌源正常/);
  } finally {
    audioServer.close();
  }
});

test('probe 失败：musicUrl 抛错时如实报告未通过', async () => {
  const session = fakeSession(async (payload) => {
    if (payload.action === 'search') {
      return { isEnd: true, songs: [{ name: '晴天', singer: '周杰伦', songmid: 'TESTMID', interval: 269 }] };
    }
    throw new Error('API 500');
  });
  const result = await runUserApiSourceProbe(session, { deadline: Date.now() + 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.summary, /未通过/);
});

test('probe 无 search 动作：仅验证初始化并跳过播放验证', async () => {
  const session = fakeSession(async () => { throw new Error('should not be called'); }, {
    inited: { sources: [{ source: 'kg', name: '酷狗', qualitys: ['128k'], actions: ['musicUrl'] }] },
  });
  const result = await runUserApiSourceProbe(session, { deadline: Date.now() + 10000 });
  assert.equal(result.ok, true, '初始化正常且无失败项时不算测试失败');
  assert.equal(result.verified, false);
  assert.equal(result.checks[0].skipped, true);
  assert.match(result.summary, /跳过播放验证/);
});

test('probe 初始化失败：没有可用的 musicUrl 动作时报告未通过', async () => {
  const session = fakeSession(async () => {}, { inited: null });
  const result = await runUserApiSourceProbe(session, { deadline: Date.now() + 10000 });
  assert.equal(result.ok, false);
  assert.match(result.summary, /未完成初始化|未声明/);
});

test('store.getSource 返回指定源的脚本内容', () => {
  const store = createUserApiStore();
  const script = "module.exports = { name: '待测源', actions: [] };\n";
  const added = store.addSource(script, { name: '待测源' });
  const got = store.getSource(added.sourceId);
  assert.equal(got.sourceText, script);
  assert.equal(store.getSource('missing'), null);
});

test('registerUserApiIpc 注册测试通道，preload 请求携带 generation', () => {
  const ipcMain = {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on(channel, listener) { this.listeners.set(channel, listener); },
    removeListener() {},
  };
  const runtime = registerUserApiIpc({
    ipcMain,
    BrowserWindow: function BrowserWindow() {},
    app: { getPath() { return path.dirname(runtimePath); }, whenReady() { return Promise.resolve(); } },
    store: createUserApiStore(),
  });
  try {
    assert.equal(typeof ipcMain.handlers.get('mineradio-lx-user-api-test'), 'function');
    assert.ok(runtime.channels.includes('mineradio-lx-user-api-test'));
    const preload = fs.readFileSync(path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-preload.js'), 'utf8');
    assert.match(preload, /generation: scriptGeneration/);
    assert.match(preload, /scriptGeneration = Number\(info\.generation\)/);
  } finally {
    runtime.dispose();
  }
});
