// 真实打开合并歌单测试:检查目录数量、缓存状态、打开加载耗时
const port = Number(process.argv[2] || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('about:'));
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const d = JSON.parse(String(ev.data));
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
};
function send(method, params = {}) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }); }
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// 1) 目录状态:userPlaylists 是否有合并歌单,显示数量
const catalog = await ev(`(() => {
  const merged = (userPlaylists || []).find(p => p && p.provider === 'merged');
  return {
    hasMerged: !!merged,
    trackCount: merged ? merged.trackCount : null,
    sources: merged ? (merged.sources || []).map(s => s.provider + ':' + s.id + '(' + s.trackCount + ')') : [],
    runtimeAccountKey: mergedPlaylistCacheRuntime.accountKey,
    runtimeHasSnapshot: !!mergedPlaylistCacheRuntime.snapshot,
    runtimeTotal: mergedPlaylistCacheRuntime.snapshot ? mergedPlaylistCacheRuntime.snapshot.total : null,
  };
})()`);
console.log('catalog:', JSON.stringify(catalog));

// 2) 文件缓存状态(真实文件目录)
const files = await ev(`(async () => {
  const keys = ['merged:' + currentMergedPlaylistAccountKey()];
  const out = [];
  for (const k of keys) {
    const r = await window.desktopWindow.mergedCache.read(k);
    out.push({ key: k, hit: !!(r && r.ok && r.hit), total: r && r.value ? r.value.total : null, tracks: r && r.value ? (r.value.tracks || []).length : null });
  }
  return out;
})()`);
console.log('file cache:', JSON.stringify(files));

// 3) 真实打开合并歌单(走 prepareMergedPlaylistCache),测缓存命中与耗时
const open = await ev(`(async () => {
  const merged = (userPlaylists || []).find(p => p && p.provider === 'merged');
  if (!merged) return { skipped: 'no merged record' };
  const t0 = performance.now();
  let cacheResult;
  try { cacheResult = await prepareMergedPlaylistCache(merged); } catch (e) { return { error: String(e && e.message || e) }; }
  const t1 = performance.now();
  return {
    cached: !!(cacheResult && cacheResult.cached),
    changed: cacheResult ? cacheResult.changed : null,
    total: cacheResult && cacheResult.snapshot ? cacheResult.snapshot.total : null,
    tracks: cacheResult && cacheResult.snapshot ? (cacheResult.snapshot.tracks || []).length : null,
    partial: cacheResult ? !!cacheResult.partial : null,
    elapsedMs: Math.round(t1 - t0),
    logHint: cacheResult && cacheResult.cached ? 'cache-hit' : 'cache-miss/full-sync',
  };
})()`);
console.log('open merged playlist:', JSON.stringify(open));

ws.close();
console.log('DONE');
