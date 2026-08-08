// 真实打开合并歌单:第一次(建缓存)vs 第二次(命中)耗时对比
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
async function ev(expression, timeoutMs = 120000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs)),
  ]);
  if (r.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// 等合并歌单目录就绪(登录态恢复 + 目录刷新)
let merged = null;
for (let i = 0; i < 30; i++) {
  merged = await ev(`(() => { const m = (userPlaylists || []).find(p => p && p.provider === 'merged'); return m ? { trackCount: m.trackCount, n: (m.sources || []).length } : null; })()`, 10000);
  if (merged) break;
  await new Promise(r => setTimeout(r, 2000));
}
console.log('merged catalog:', JSON.stringify(merged));

// 第一次打开(建缓存,可能全量网络拉取)
console.log('--- first open (expect miss -> full sync) ---');
const first = await ev(`(async () => {
  const m = (userPlaylists || []).find(p => p && p.provider === 'merged');
  if (!m) return { skipped: 'no merged' };
  const t0 = performance.now();
  let r;
  try { r = await prepareMergedPlaylistCache(m); } catch (e) { return { error: String(e && e.message || e), elapsedMs: Math.round(performance.now() - t0) }; }
  const ms = Math.round(performance.now() - t0);
  return {
    cached: !!r.cached, changed: !!r.changed, partial: !!r.partial,
    total: r.snapshot ? r.snapshot.total : null,
    tracks: r.snapshot ? (r.snapshot.tracks || []).length : null,
    elapsedMs: ms,
  };
})()`, 180000);
console.log('first open:', JSON.stringify(first));

// 第二次打开(应命中缓存)
console.log('--- second open (expect cache-hit) ---');
const second = await ev(`(async () => {
  const m = (userPlaylists || []).find(p => p && p.provider === 'merged');
  if (!m) return { skipped: 'no merged' };
  const t0 = performance.now();
  let r;
  try { r = await prepareMergedPlaylistCache(m); } catch (e) { return { error: String(e && e.message || e), elapsedMs: Math.round(performance.now() - t0) }; }
  const ms = Math.round(performance.now() - t0);
  return {
    cached: !!r.cached, changed: !!r.changed, partial: !!r.partial,
    total: r.snapshot ? r.snapshot.total : null,
    tracks: r.snapshot ? (r.snapshot.tracks || []).length : null,
    elapsedMs: ms,
  };
})()`, 60000);
console.log('second open:', JSON.stringify(second));

// 目录显示数量(应为缓存真实数)
const catalogAfter = await ev(`(() => { const m = (userPlaylists || []).find(p => p && p.provider === 'merged'); return { trackCount: m ? m.trackCount : null }; })()`, 10000);
console.log('catalog after open:', JSON.stringify(catalogAfter));

ws.close();
console.log('DONE');
