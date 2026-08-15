// VIP/付费曲目音频候选探测必须有界：上游忽略 Range 时不能把整首歌下载完，
// 上游挂起时不能无限等待。否则播放会"加载很久"甚至永远不开始。
// 这里用本地 HTTP 服务器验证 validateAudioCandidate 的探测行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const integrityPath = path.join(__dirname, '..', '.mineradio-lx-addon', 'runtime', 'playback-integrity.js');
const { validateAudioCandidate } = require(integrityPath);

const PROBE_MAX_BYTES = 512 * 1024;

test('playback-integrity 探测带超时与字节上限（回归：整歌下载/无限等待）', () => {
  const source = fs.readFileSync(integrityPath, 'utf8');
  assert.match(source, /PROBE_TIMEOUT_MS\s*=\s*\d+/);
  assert.match(source, /PROBE_MAX_BYTES\s*=\s*512\s*\*\s*1024/);
  // 探测必须使用流式读取 + 提前取消，而不是无上限的 arrayBuffer()
  assert.match(source, /getReader\(\)/);
  assert.match(source, /reader\.cancel\(\)/);
  // Range 只请求探测所需的前缀
  assert.match(source, /Range:\s*'bytes=0-'\s*\+/);
});

test('上游忽略 Range 时探测只读取前缀并提前取消（不下载整首歌）', async () => {
  const totalBytes = 32 * 1024 * 1024; // 32MB "VIP 歌曲"
  const expectedDurationSec = 240;
  let served = 0;
  let clientClosedEarly = false;
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(totalBytes),
      'x-audio-duration': String(expectedDurationSec),
      // 故意不处理 Range：模拟忽略 Range 的 CDN
    });
    res.on('close', () => { clientClosedEarly = true; });
    const first = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(64 * 1024 - 3, 0x50)]); // 前导 MP3 ID3 魔数
    const chunk = Buffer.alloc(64 * 1024, 0x50); // 'P' 填充
    let firstSent = false;
    function pump() {
      if (clientClosedEarly || res.destroyed || res.writableEnded) return;
      if (served >= totalBytes) { res.end(); return; }
      const next = firstSent ? chunk : first;
      firstSent = true;
      res.write(next, () => {
        served += next.length;
        setImmediate(pump);
      });
    }
    pump();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const candidate = {
      upstreamUrl: `http://127.0.0.1:${port}/vip.flac`,
      sourceId: 'test',
      generation: 1,
      songKey: 'test:vip-track',
      expectedDurationSec,
      quality: 'standard',
    };
    const started = Date.now();
    const result = await validateAudioCandidate(candidate, { expectedDurationSec, quality: 'standard' });
    const elapsedMs = Date.now() - started;
    assert.equal(result.completeness, 'full', '探测应识别为完整音频');
    assert.ok(elapsedMs < 3000, `探测应在 3s 内完成，实际 ${elapsedMs}ms`);
    assert.equal(requestCount, 1);
    // 服务器应因客户端提前取消而未发完整首歌
    assert.ok(clientClosedEarly || served < totalBytes,
      `客户端应提前取消下载（served=${served}/${totalBytes}）`);
  } finally {
    server.close();
  }
});

test('上游挂起时探测有超时上限（不会无限等待）', async () => {
  const server = http.createServer(() => {
    // 接受连接但永不返回响应头：模拟 CDN 挂起
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const candidate = {
      upstreamUrl: `http://127.0.0.1:${port}/hang.flac`,
      sourceId: 'test',
      generation: 2,
      songKey: 'test:hang-track',
      expectedDurationSec: 200,
      quality: 'standard',
    };
    const started = Date.now();
    let rejected = null;
    try {
      await validateAudioCandidate(candidate, { expectedDurationSec: 200, quality: 'standard' });
    } catch (error) {
      rejected = error;
    }
    const elapsedMs = Date.now() - started;
    assert.ok(rejected !== null, '挂起的上游应触发探测超时并抛错');
    // 10s 超时 + 缓冲余量：必须远小于无超时（5 分钟级）的等待
    assert.ok(elapsedMs < 15000, `探测超时应生效，实际 ${elapsedMs}ms`);
    assert.ok(elapsedMs >= 9000, `探测超时不应过早触发，实际 ${elapsedMs}ms`);
  } finally {
    server.close();
  }
});
