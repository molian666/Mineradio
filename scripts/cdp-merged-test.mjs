// CDP 端到端测试:验证合并歌单缓存文件桥接与显示数量逻辑
// 用法: node scripts/cdp-merged-test.mjs <port>
const port = Number(process.argv[2] || 9222);

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(new Error('ws error: ' + (e && e.message || e)));
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message));
        else res(data.result);
      }
    };
  });
}

async function evaluate(session, expression, awaitPromise = true) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}

const targets = await getTargets();
const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map(t => [t.type, t.url])));
console.log('target:', page.url);
const session = await connect(page.webSocketDebuggerUrl);
console.log('connected');

// 1) 桥接存在性
const bridgeType = await evaluate(session, 'typeof window.desktopWindow !== "undefined" && typeof window.desktopWindow.mergedCache');
console.log('mergedCache bridge:', bridgeType);

// 2) 文件缓存真实读写删
const cacheProbe = await evaluate(session, `(async () => {
  const mc = window.desktopWindow.mergedCache;
  await mc.write('merged:cdp-test', { probe: true, n: 42 });
  const r = await mc.read('merged:cdp-test');
  const miss = await mc.read('merged:cdp-nope');
  await mc.remove('merged:cdp-test');
  const after = await mc.read('merged:cdp-test');
  return { hit: !!(r && r.ok && r.hit && r.value && r.value.n === 42), miss: !!(miss && miss.ok && !miss.hit), removed: !!(after && after.ok && !after.hit) };
})()`);
console.log('file cache roundtrip:', JSON.stringify(cacheProbe));

// 3) 显示数量逻辑
const displayProbe = await evaluate(session, `(() => {
  const sources = [
    { provider: 'netease', id: 'n1', name: 'N', trackCount: 150 },
    { provider: 'qq', id: 'q1', name: 'Q', trackCount: 123 },
  ];
  const noCache = buildMergedPlaylistRecord(sources).trackCount;               // 273 预估
  const key = currentMergedPlaylistAccountKey();
  mergedPlaylistCacheRuntime.accountKey = key;
  mergedPlaylistCacheRuntime.snapshot = {
    version: 1, accountKey: key,
    sources: [
      { provider: 'netease', id: 'n1', name: 'N', trackCount: 150, tracks: [] },
      { provider: 'qq', id: 'q1', name: 'Q', trackCount: 123, tracks: [] },
    ],
    tracks: [], total: 250, partial: false, errors: [], savedAt: Date.now(),
  };
  const withCache = buildMergedPlaylistRecord(sources).trackCount;              // 250 真实
  // 缓存账号不匹配时退回预估
  mergedPlaylistCacheRuntime.accountKey = 'other-account';
  const otherAccount = buildMergedPlaylistRecord(sources).trackCount;
  mergedPlaylistCacheRuntime.accountKey = key;
  return { noCache, withCache, otherAccount, key };
})()`);
console.log('display probe:', JSON.stringify(displayProbe));

// 4) 文件缓存命中:写入 snapshot 后 loadMergedPlaylistCache 应命中
const loadProbe = await evaluate(session, `(async () => {
  const key = 'merged:' + currentMergedPlaylistAccountKey();
  const snapshot = {
    version: 1, accountKey: currentMergedPlaylistAccountKey(),
    sources: [{ provider: 'netease', id: 'n1', name: 'N', trackCount: 150, tracks: [{ provider: 'netease', id: 't1', name: 'T', artist: 'A' }] }],
    tracks: [{ provider: 'netease', id: 't1', name: 'T', artist: 'A' }],
    total: 1, partial: false, errors: [], savedAt: Date.now(),
  };
  await window.desktopWindow.mergedCache.write(key, snapshot);
  const loaded = await loadMergedPlaylistCache(currentMergedPlaylistAccountKey(), getMergedPlaylistCacheAdapter());
  await window.desktopWindow.mergedCache.remove(key);
  return { hit: !!(loaded && loaded.tracks && loaded.tracks.length === 1), adapterHasBridge: !!getMergedPlaylistCacheAdapter() };
})()`);
console.log('file cache load:', JSON.stringify(loadProbe));

session.close();
console.log('DONE');
