// 导入音源显示名称守卫（回归）：
// 分发型 URL（如 .../latest.js）导入的歌源必须显示脚本自身声明的名称，
// 而不是统一变成 "latest"。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimePath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-main.js');
const storePath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-store.js');
const { createUserApiStore, detectSourceName } = require(storePath);
const { registerUserApiIpc, readUserApiSourceFile } = require(runtimePath);

function createIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on(channel, listener) { this.listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
    },
  };
}

test('detectSourceName 读取 module.exports 的 name（lx-music UserApi 实际格式）', () => {
  const script = 'module.exports = { name: "网易云源", description: "x" };';
  assert.equal(detectSourceName(script), '网易云源');
});

test('detectSourceName 读取 export default 的 name（宽松兼容）', () => {
  const script = "const apis = {};\nexport default { name: 'QQ 音乐源', version: '1.0.0', sources: ['tx'], qualitys: ['128k'], actions: [] };\n";
  assert.equal(detectSourceName(script), 'QQ 音乐源');
});

test('detectSourceName 读取 @name 头注释且不误匹配 @namespace', () => {
  const script = "// @namespace https://example.com\n// @name 酷我歌源\n// @version 1.0\n// @description 酷我音乐\nconst x = 1;\nmodule.exports = { sources: ['kw'], qualitys: ['128k'], actions: [] };\n";
  assert.equal(detectSourceName(script), '酷我歌源');
});

test('detectSourceName 兼容压缩脚本与长 actions 列表', () => {
  const compact = 'module.exports={name:"TxSource",qualitys:["128k","320k"],actions:[]}';
  assert.equal(detectSourceName(compact), 'TxSource');
  const longActions = 'module.exports = {' + ' actions: [' + '0,'.repeat(1200) + '], name: "排尾名称源" };';
  assert.equal(detectSourceName(longActions), '排尾名称源');
});

test('detectSourceName 没有声明名称时返回空', () => {
  assert.equal(detectSourceName('module.exports = { sources: ["wy"], qualitys: ["128k"], actions: [] };'), '');
  assert.equal(detectSourceName(''), '');
  assert.equal(detectSourceName('const a = 1;'), '');
});

test('addSource 在未显式命名时自动读取脚本名称', () => {
  const store = createUserApiStore();
  const script = "// @name 自动识别源\nmodule.exports = { name: '自动识别源', actions: [] };\n";
  const added = store.addSource(script, { name: '' });
  assert.equal(added.metadata.name, '自动识别源');
});

test('addSource 保留用户显式填写的名称', () => {
  const store = createUserApiStore();
  const script = "module.exports = { name: '脚本内名称', actions: [] };\n";
  const added = store.addSource(script, { name: '我的自定义名称' });
  assert.equal(added.metadata.name, '我的自定义名称');
});

test('getState 对历史 "latest" 命名自动用脚本名称修正显示（无需重新导入）', () => {
  const store = createUserApiStore();
  const script = "module.exports = { name: '真实歌源名', actions: [] };\n";
  store.addSource(script, { name: 'latest' });
  const state = store.getState();
  assert.equal(state.sources[0].metadata.name, '真实歌源名');
});

test('readUserApiSourceFile 返回脚本声明的名称优先于文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-lx-'));
  const file = path.join(dir, 'latest.js');
  fs.writeFileSync(file, "module.exports = { name: '本地文件源', actions: [] };\n", 'utf8');
  try {
    const picked = readUserApiSourceFile(file);
    assert.equal(picked.text.includes('本地文件源'), true);
    assert.equal(picked.detectedName, '本地文件源');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('URL 导入时名称取脚本声明值而不是 latest.js 文件名', async () => {
  const script = "// @name 汽水 VIP 源\nconst apis = {};\nmodule.exports = { name: '汽水 VIP 源', sources: ['kg'], qualitys: ['128k'], actions: [] };\n";
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(script);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ipcMain = createIpcMain();
  const runtime = registerUserApiIpc({
    ipcMain,
    BrowserWindow: function BrowserWindow() {},
    app: {
      getPath() { return os.tmpdir(); },
      whenReady() { return Promise.resolve(); },
    },
    store: createUserApiStore(),
    preloadPath: path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'user-api-preload.js'),
  });
  try {
    const handler = ipcMain.handlers.get('mineradio-lx-user-api-import-url');
    assert.equal(typeof handler, 'function');
    const result = await handler({}, `http://127.0.0.1:${port}/latest.js`);
    assert.equal(result.metadata.name, '汽水 VIP 源');
  } finally {
    server.close();
    await runtime.dispose();
  }
});
