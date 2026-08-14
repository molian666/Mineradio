// 开放代理 SSRF 防护回归测试
// /api/audio 与 /api/cover 是开放代理接口，必须拒绝环回/私网/链路本地
// 目标（与 .mineradio-lx-addon/runtime/approved-audio-proxy.js 的
// isPrivateHost 同一安全模型），防止本机进程与局域网设备借其访问
// 内网服务或云元数据（169.254.169.254）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

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

test('isPrivateUpstreamUrl 拒绝环回、私网与链路本地地址', () => {
  const isPrivate = extractFunction(serverSource, 'isPrivateUpstreamUrl', { URL });
  const privateUrls = [
    'http://localhost:3000/x',
    'http://127.0.0.1/x',
    'http://0.0.0.0/x',
    'http://10.0.0.5/x',
    'http://172.16.1.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.100/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://mylocal.local/x',
    'ftp://example.com/x',
    'not-a-url',
    '',
  ];
  for (const url of privateUrls) {
    assert.equal(isPrivate(url), true, `expected private: ${url}`);
  }
});

test('isPrivateUpstreamUrl 放行公网目标', () => {
  const isPrivate = extractFunction(serverSource, 'isPrivateUpstreamUrl', { URL });
  const publicUrls = [
    'https://music.163.com/a.mp3',
    'http://y.qq.com/b.m4a',
    'http://172.32.0.1/x',
    'http://[2001:db8::1]/x',
    'http://example.com:8080/x',
    'https://qpic.cn/cover.jpg',
  ];
  for (const url of publicUrls) {
    assert.equal(isPrivate(url), false, `expected public: ${url}`);
  }
});

test('server.js 必须把 SSRF 防护应用到 /api/audio 与 /api/cover', () => {
  // /api/cover 与 /api/audio 代理前调用 isPrivateUpstreamUrl 并拒绝 403
  const coverGuard = /isPrivateUpstreamUrl\(coverUrl\)[\s\S]{0,160}403/.test(serverSource);
  const audioGuard = /isPrivateUpstreamUrl\(audioUrl\)[\s\S]{0,160}403/.test(serverSource);
  assert.equal(coverGuard, true, '/api/cover 必须拒绝私网目标');
  assert.equal(audioGuard, true, '/api/audio 必须拒绝私网目标');
  // 默认监听地址必须是回环（纯 node 运行时也不暴露局域网）
  assert.match(serverSource, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1'/);
});
