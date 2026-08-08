// 开发环境验证:显示数量修复(restore + prepare 目录同步)
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
async function ev(expression, timeoutMs = 30000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs)),
  ]);
  if (r.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const out = await ev(`(async () => {
  const result = {};
  const sources = [
    { provider: 'netease', id: 'a', name: 'A', trackCount: 150, cover: '', creator: 'u' },
    { provider: 'qq', id: 'b', name: 'B', trackCount: 123, cover: '', creator: 'u' },
  ];
  const tracks = Array.from({ length: 250 }, (_, i) => ({ provider: 'netease', id: 't' + i, name: 'T' + i, artist: 'A' }));

  // 注入登录态(模拟已登录 3 平台)
  loginStatus.loggedIn = true; loginStatus.userId = 'n1';
  qqLoginStatus.loggedIn = true; qqLoginStatus.userId = 'q1';
  kugouLoginStatus.loggedIn = true; kugouLoginStatus.userId = 'k1';
  qishuiLoginStatus.loggedIn = false;
  spotifyLoginStatus.loggedIn = false;
  const key = currentMergedPlaylistAccountKey();
  result.key = key;

  // 1) 无缓存:buildMergedPlaylistRecord 显示预估和 273
  mergedPlaylistCacheRuntime.accountKey = '';
  mergedPlaylistCacheRuntime.snapshot = null;
  result.noCache = buildMergedPlaylistRecord(sources).trackCount;

  // 2) 写入文件缓存(去重后 total=250)
  const snapshot = {
    version: 1, accountKey: key,
    sources: sources.map(s => Object.assign({}, s, { tracks: [] })),
    tracks, total: 250, partial: false, errors: [], savedAt: Date.now(),
  };
  await window.desktopWindow.mergedCache.write('merged:' + key, snapshot);
  const readback = await window.desktopWindow.mergedCache.read('merged:' + key);
  result.fileHit = !!(readback && readback.ok && readback.hit && readback.value && readback.value.total === 250);

  // 3) restore:应命中文件缓存,目录显示 250(而非 273/510)
  fx.shelfMergeCollections = true;
  result.restored = await restoreMergedPlaylistCatalogCache();
  const merged = (userPlaylists || []).find(p => p && p.provider === 'merged');
  result.restoreTrackCount = merged ? merged.trackCount : null;

  // 4) prepare(缓存命中)→ 目录计数同步仍为 250
  let prepared = null;
  try { prepared = await prepareMergedPlaylistCache(merged); } catch (e) { result.prepareError = String(e && e.message || e); }
  result.preparedCached = !!(prepared && prepared.cached);
  result.preparedTotal = prepared && prepared.snapshot ? prepared.snapshot.total : null;
  const merged2 = (userPlaylists || []).find(p => p && p.provider === 'merged');
  result.catalogAfterPrepare = merged2 ? merged2.trackCount : null;

  // 5) 账号不匹配时退回预估(防串账号)
  mergedPlaylistCacheRuntime.accountKey = 'someone-else';
  mergedPlaylistCacheRuntime.snapshot = null;
  result.otherAccount = buildMergedPlaylistRecord(sources).trackCount;

  // 清理
  await window.desktopWindow.mergedCache.remove('merged:' + key);
  return result;
})()`);
console.log('dev verify:', JSON.stringify(out, null, 2));
ws.close();
console.log('DONE');
