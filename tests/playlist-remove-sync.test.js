'use strict';
// 歌单移除/删除 + 合并歌单来源同步 回归测试
// 覆盖：
//   1. 后端四个平台"从歌单移除歌曲"端点与网易云/Spotify"删除歌单"端点存在；
//   2. 各平台 handler（spotify/kugou/qishui）实现并导出；
//   3. 前端 adapter 暴露 playlistRemoveUrl / playlistDeleteUrl；
//   4. 合并歌单歌曲组装时记录来源歌单 id 与平台（sourcePlaylistId /
//      sourcePlaylistProvider），供 merged 详情"从歌单移除"定位到源平台歌单；
//   5. merged 详情移除支持来源反查与 Spotify 喜欢伪歌单（spotify-liked）
//      强制取消红心（避免 likedSongMap 未同步时 toggle 反向重新喜欢）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const server = () => read('server.js');
const detail = () => read('public/js/modules/06-lyrics/02-playlist-detail.js');
const merged = () => read('public/js/modules/06-lyrics/01a-merged-playlist.js');
const actions = () => read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');

test('liked playlist removal clears the local like state without a second unlike request', () => {
  const detailSource = detail();
  assert.match(detailSource, /source\.likedPlaylist/);
  assert.match(detailSource, /source\.likedPlaylist[\s\S]{0,500}?likedSongMap\[key\] = false/);
});

test('后端：四个平台"从歌单移除歌曲"端点存在', () => {
  const src = server();
  ['/api/playlist/remove-song', '/api/spotify/playlist/remove-song',
    '/api/kugou/playlist/remove-song', '/api/qishui/playlist/remove-song'
  ].forEach((ep) => {
    assert.match(src, new RegExp(`pn === '${ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `缺少端点 ${ep}`);
  });
});

test('后端：网易云 / Spotify 删除歌单端点存在', () => {
  const src = server();
  assert.match(src, /pn === '\/api\/playlist\/delete'/);
  assert.match(src, /pn === '\/api\/spotify\/playlist\/delete'/);
  // NeteaseCloudMusicApi 的 playlist_delete 已导入
  assert.match(src, /playlist_delete,/);
});

test('后端：各平台 handler 实现并导出', () => {
  assert.match(read('spotify-api.js'), /async function handleSpotifyPlaylistRemoveSong/);
  assert.match(read('spotify-api.js'), /async function handleSpotifyPlaylistDelete/);
  assert.match(read('spotify-api.js'), /handleSpotifyPlaylistRemoveSong,/);
  assert.match(read('spotify-api.js'), /handleSpotifyPlaylistDelete,/);
  assert.match(read('kugou-api.js'), /async function handleKugouPlaylistRemoveSong/);
  assert.match(read('kugou-api.js'), /handleKugouPlaylistRemoveSong,/);
  assert.match(read('qishui-api.js'), /async function handleQishuiPlaylistRemoveSong/);
  assert.match(read('qishui-api.js'), /handleQishuiPlaylistRemoveSong,/);
  // 汽水移除端点与 append 对称（推断路径）
  assert.match(read('qishui-api.js'), /\/luna\/pc\/me\/playlist\/media\/delete/);
});

test('前端：adapter 暴露移除/删除 URL（qishui 受写入门控）', () => {
  const src = actions();
  assert.match(src, /playlistRemoveUrl: '\/api\/playlist\/remove-song'/);
  assert.match(src, /playlistDeleteUrl: '\/api\/playlist\/delete'/);
  assert.match(src, /playlistRemoveUrl: '\/api\/kugou\/playlist\/remove-song'/);
  assert.match(src, /playlistRemoveUrl: '\/api\/spotify\/playlist\/remove-song'/);
  assert.match(src, /playlistDeleteUrl: '\/api\/spotify\/playlist\/delete'/);
  assert.match(src, /playlistRemoveUrl: QISHUI_PLAYLIST_WRITE_ACTIONS_ENABLED \? '\/api\/qishui\/playlist\/remove-song' : ''/);
  // 酷狗/汽水无删除歌单接口 → playlistDeleteUrl 留空
  assert.match(src, /playlistDeleteUrl: '',\n\s+playlistTracksUrl: '\/api\/kugou\/playlist\/tracks'/);
  assert.match(src, /playlistDeleteUrl: '',\n\s+playlistTracksUrl: '\/api\/qishui\/playlist\/tracks'/);
});

test('合并歌单：组装时记录来源歌单 id 与平台', () => {
  const src = merged();
  // 三处组装（全量缓存、流式分页、去重）都必须附加来源字段
  assert.equal((src.match(/normalized\.sourcePlaylistId == null\) normalized\.sourcePlaylistId = source\.id;/g) || []).length, 3);
  assert.equal((src.match(/normalized\.sourcePlaylistProvider == null\) normalized\.sourcePlaylistProvider = source\.provider;/g) || []).length, 3);
});

test('歌单详情：merged 来源定位与 Spotify 喜欢伪歌单强制取消红心', () => {
  const src = detail();
  assert.match(src, /function resolveMergedTrackSource\(song\)/);
  // 来源平台以组装时记录为准（song.provider 可能不一致）
  assert.match(src, /sourcePlaylistProvider \|\| song\.provider \|\| songAccountProvider\(song\)/);
  // 旧缓存快照反查兜底
  assert.match(src, /var snapshot = typeof mergedPlaylistCacheRuntime !== 'undefined'/);
  assert.match(src, /Array\.isArray\(snapshot\.sources\)/);
  // Spotify 喜欢伪歌单（无真实歌单实体）→ 预置 likedSongMap 后走 unlike，而非 playlist remove
  assert.match(src, /likedSongMap\[spotifyKey\] = true;/);
  assert.match(src, /'spotify-liked'/);
  // merged 详情红心同样预置，避免 toggle 反向
  assert.match(src, /function detailTrackInLikedContext\(song\)/);
  // 共享移除核心：来源移除成功后在"喜欢类"来源下同步清红心
  assert.match(src, /async function removeSongFromSourcePlaylist\(song, source\)/);
  assert.match(src, /source\.liked\) \{/);
  assert.match(src, /if \(key\) likedSongMap\[key\] = true;/);
});

test('3D 歌单架：卡片"删除歌单"按钮与命中检测', () => {
  const core = read('public/js/modules/04-shelf/01-manager-core.js');
  const inter = read('public/js/modules/04-shelf/05-card-interactions.js');
  // 可见性判定全局导出（makeShelfManager 内部与交互层共用）
  assert.match(core, /function shelfPlaylistCanDelete\(item\)/);
  assert.match(core, /item\.specialType === 5 \|\| item\.subscribed/);
  // spotify 喜欢伪歌单不可删除
  assert.match(core, /\^\(spotify-liked\|liked\)\$/);
  // item 携带可删除判定所需字段
  assert.match(core, /subscribed: !!pl\.subscribed, specialType: Number\(pl\.specialType \|\| 0\), virtual: !!pl\.virtual/);
  // 中央卡绘制"删除歌单"按钮（x 632-702，与命中区 0.878 对齐）
  assert.match(core, /tx \+ 266, actionY, 70, 38/);
  assert.match(core, /'删除歌单'/);
  // 命中检测仅在按钮真实绘制时命中（并入 shelfPlaylistCanDelete，避免吞点击）
  assert.match(inter, /function isShelfPlaylistDeleteHit\(hit\)/);
  assert.match(inter, /shelfPlaylistCanDelete\(hit\.card\.item\)/);
  assert.match(inter, /hit\.uv\.x >= 0\.878/);
  // 点击处理：删除优先于播放/打开
  assert.match(inter, /if \(isShelfPlaylistDeleteHit\(hit\)\) \{\n\s+deleteShelfPlaylistCard\(hit\.card\.item\);/);
});

test('3D 歌单架内容框：歌曲行"从歌单移除"按钮', () => {
  const content = read('public/js/modules/04-shelf/03-content-list-manager.js');
  const inter = read('public/js/modules/04-shelf/05-card-interactions.js');
  // 共享移除核心函数已抽取（详情面板与内容框共用，含合并歌单同步）
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  assert.match(detail, /async function removeSongFromSourcePlaylist\(song, source\)/);
  assert.match(detail, /markMergedPlaylistDirty\('playlist-remove-song'\)/);
  assert.match(detail, /async function removeDetailPlaylistTrack\(index\)[\s\S]*removeSongFromSourcePlaylist\(song, source\)/);
  // 内容框可移除判定：merged 按来源定位，喜欢类歌单也保留移除入口
  assert.match(content, /function contentRowCanRemove\(song\)/);
  assert.match(content, /MERGED_PLAYLIST_PROVIDER/);
  assert.match(content, /resolveMergedTrackSource\(song\)/);
  assert.match(content, /function contentIsLikedContext\(\)/);
  // 行绘制：最左侧 × 移除按钮（removeX = likeX - 52）
  assert.match(content, /var removeX = likeX - 52;/);
  assert.match(content, /contentRowCanRemove\(song\)/);
  // 移除方法：成功后从列表移除该行并刷新
  assert.match(content, /removeRowAt: removeRowAt/);
  assert.match(content, /async function removeRowAt\(row\)/);
  assert.match(content, /allTracks\.splice\(idx, 1\)/);
  // 点击检测：移除按钮命中 + rowActionAtScreen remove 分支 + 处理优先级
  assert.match(inter, /hitRemoveButton = rowHit\.uv && rowHit\.uv\.x >= 0\.54/);
  assert.match(inter, /cl\.canRemoveRow \|\| cl\.canRemoveRow\(rowHit\.row\)\);/);
  assert.match(inter, /screenAction === 'remove'/);
  assert.match(inter, /if \(selectedRow && !rowIsPodcastRadio && hitRemoveButton\) \{\n\s+if \(cl\.removeRowAt\) cl\.removeRowAt\(rowHit\.row\);/);
  // 屏幕坐标辅助命中同样仅在可移除时生效（避免吞掉"我的喜欢"等行的红心点击）
  assert.match(content, /contentRowCanRemove\(row && row\.song\)\) return 'remove';/);
  assert.match(content, /canRemoveRow: function \(row\) \{ return contentRowCanRemove\(row && row\.song\); \}/);
});

test('合并歌单同步：写操作（红心/移除）失效缓存后强制重建', () => {
  const loaders = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
  // 写操作脏标记必须强制重建：invalidate 会把 snapshot 置空，
  // 若沿用"无缓存跳过"逻辑，缓存删除后无人重建，目录与内容停留在旧值
  assert.match(loaders, /scheduleMergedPlaylistCacheSync\(reason, 0, true\)/);
  assert.match(loaders, /function scheduleMergedPlaylistCacheSync\(reason, delayMs, forceBuild\)/);
  assert.match(loaders, /!mergedPlaylistCacheRuntime\.snapshot && !forceBuild\) return Promise\.resolve\(null\);/);
  // 延迟分支透传 forceBuild，避免延迟执行时丢失强制重建标记
  assert.match(loaders, /resolve\(scheduleMergedPlaylistCacheSync\(reason, 0, forceBuild\)\)/);
  // 写操作遇进行中的同步：等其完成后强制重建，避免旧数据重新持久化
  assert.match(loaders, /if \(forceBuild\) \{\n\s+return mergedPlaylistCacheRuntime\.promise\.then\(function \(\) \{\n\s+return scheduleMergedPlaylistCacheSync\(reason, 0, true\);/);
  // "添加歌曲到指定歌单"（收藏）成功也走脏标记 → 合并歌单同步
  const actions = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
  assert.match(actions, /markMergedPlaylistDirty\('playlist-collect'\)/);
  // "我喜欢的音乐"（specialType 5）作为普通歌单进入合并歌单 sources
  const merged = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  assert.match(merged, /function buildMergedPlaylistRecord\(sourcePlaylists\)/);
});

test('QQ 音乐平台完整同步（喜欢/歌单写操作）', () => {
  const src = read('server.js');
  const actions = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
  // 后端 6 个 QQ 写操作端点
  ['/api/qq/song/like', '/api/qq/song/like/check', '/api/qq/playlist/add-song',
    '/api/qq/playlist/remove-song', '/api/qq/playlist/create', '/api/qq/playlist/delete'
  ].forEach((ep) => {
    assert.match(src, new RegExp(`pn === '${ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `缺少 QQ 端点 ${ep}`);
  });
  // 红心/歌单歌曲写操作：musicu.fcg 的 music.musicasset.PlaylistDetailWrite（AddSonglist/DelSonglist）
  assert.match(src, /module: 'music\.musicasset\.PlaylistDetailWrite'/);
  assert.match(src, /method: isDelete \? 'DelSonglist' : 'AddSonglist'/);
  // DelSonglist 需要 bFmtUtf8=1（整数）而非 true（L-1124 preserve_bool 序列化验证）
  assert.match(src, /bFmtUtf8: isDelete \? 1 : true, v_songInfo/);
  // 三层 code 判定：req_0.code 非 0（如 80105）不得被 retCode=0 掩盖成成功
  assert.match(src, /const code = qqNum\(body && body\.code\) \|\| qqNum\(block && block\.code\) \|\| qqNum\(data && data\.retCode\);/);
  assert.match(src, /QQSONGLIST_WRITE_FAILED:' \+ code\)\);/);
  assert.match(src, /songId: Number\(s && \(s\.qqId \|\| s\.songid \|\| s\.id\)\) \|\| 0/);
  // 红心 = AddSonglist/DelSonglist 操作"我喜欢"歌单(dirid=201)
  assert.match(src, /qqMusicSonglistWrite\(QQ_LIKED_DIRID, \[song\], !like\)/);
  // "我的喜欢"伪歌单(id='liked')映射为数字 dirid=201
  assert.match(src, /dirid === QQ_LIKED_PLAYLIST_ID \|\| dirid === 'qq-liked'\) dirid = String\(QQ_LIKED_DIRID\)/);
  // 创建/删除歌单：music.musicasset.PlaylistBaseWrite（AddPlaylist/DelPlaylist）
  assert.match(src, /module: 'music\.musicasset\.PlaylistBaseWrite'/);
  assert.match(src, /method: 'AddPlaylist', param: \{ dirName: name \}/);
  assert.match(src, /method: 'DelPlaylist', param: \{ dirId: Number\(dirid\) \|\| 0 \}/);
  // 喜欢状态检查：CgiGetDiss 分页（禁用的老 fcgi getmyfav 不得回归）
  assert.match(src, /fetchQQLikedPlaylistPage\(\{ limit: 100, offset \}\)/);
  assert.doesNotMatch(src, /fcg_musiclist_getmyfav/);
  // 错误映射：操作不生效 80092 幂等成功、未登录→401、授权不完整→401、缺 musickey→401
  assert.match(src, /if \(code === 80092\) return \{ provider: 'qq', loggedIn: true, dirId: String\(dirId\), success: true, idempotent: true, body: result\.body \};/);
  assert.match(src, /if \(code === 403 \|\| code === 80105\) \{ logQQWriteRejected\(code, result\.variant\); throw new Error\('QQ_AUTH_INCOMPLETE:/);
  // 写操作前置校验：OAuth 会话（无 qqmusic_key）直接给出可操作提示
  assert.match(src, /QQ_MUSICKEY_REQUIRED:QQ 音乐写操作需要网页版授权/);
  assert.match(src, /LOGIN_REQUIRED\|AUTH_INCOMPLETE\|MUSICKEY\|WECHAT\/i\.test\(String\(err\.message \|\| ''\)\) \? 401/);
  assert.match(src, /QQ_WECHAT_WRITE_UNSUPPORTED:微信登录仅支持播放与读取/);
  // like/check 端点同样把授权不完整/播放登录缺失映射为 401
  assert.match(src, /if \(pn === '\/api\/qq\/song\/like\/check'\) \{[\s\S]{0,600}?LOGIN_REQUIRED\|AUTH_INCOMPLETE\|MUSICKEY\|WECHAT\|PLAYBACK_LOGIN\/i\.test\(String\(err\.message \|\| ''\)\) \? 401 : 500;/);
  // 前端 adapter：QQ 完整能力 + 6 URL，无 readOnly
  assert.match(actions, /qq: \{\n\s+provider: 'qq',\n\s+label: 'QQ 音乐',\n\s+like: true,\n\s+collect: true,\n\s+createPlaylist: true,/);
  assert.match(actions, /likeCheckUrl: '\/api\/qq\/song\/like\/check'/);
  assert.match(actions, /playlistRemoveUrl: '\/api\/qq\/playlist\/remove-song'/);
  assert.match(actions, /playlistDeleteUrl: '\/api\/qq\/playlist\/delete'/);
  assert.doesNotMatch(actions, /qq: \{\n\s+provider: 'qq',[\s\S]*?readOnly: true/);
});

test('QQ 微信/OAuth 会话写操作拦截与登录方式引导', () => {
  const src = read('server.js');
  const statusUi = read('public/js/modules/08-account/02-login-status.js');
  // 会话类型解析：wechat / oauth / qq / none
  assert.match(src, /function qqLoginSessionType\(obj\)/);
  // psrf_qqopenid/psrf_qqunionid 是 QQ 互联 OAuth 标准字段，QQ 号登录也携带，不得作为微信判据
  assert.match(src, /if \(!!obj\.wxopenid \|\| !!obj\.wxuin \|\| !!obj\.wxskey \|\| !!obj\.wxrefresh_token \|\| Number\(obj\.login_type\) === 2\) return 'wechat'/);
  assert.match(src, /psrf_qqopenid\/unionid 是 QQ 互联 OAuth 标准字段，QQ 号登录也携带，不能作微信判据/);
  assert.match(src, /if \(!!\(obj\.qm_keyst \|\| obj\.qqmusic_key \|\| obj\.music_key\)\) return 'qq'/);
  assert.match(src, /if \(!!obj\.psrf_qqaccess_token\) return 'oauth'/);
  // 403/80105 拒绝时输出诊断日志（会话类型 + cookie 字段名）
  assert.match(src, /function logQQWriteRejected\(code, variant\)/);
  assert.match(src, /logQQWriteRejected\(code, result\.variant\); throw new Error\('QQ_AUTH_INCOMPLETE:/);
  // 写操作 cookie 变体重试：完整 → 精简(仅票据) → 无 cookie，绕开 OAuth 会话 80105
  assert.match(src, /function qqWriteCookieVariants\(\)/);
  assert.match(src, /async function qqWriteWithVariants\(buildPayload, opts\)/);
  assert.match(src, /\[\['full', variants\.full\], \['slim', variants\.slim\], \['none', variants\.none\]\]/);
  // 80105/403 是会话级拒绝：继续尝试下一变体（核心：变体切换必须对业务码生效）
  assert.match(src, /if \(code === 403 \|\| code === 80105\) continue;/);
  // 网络层错误仅幂等写重试，非幂等写(创建/删除歌单)直接抛错避免重复创建
  assert.match(src, /if \(opts\.idempotent !== true\) throw err;/);
  assert.match(src, /\}, \{ idempotent: true \}\)/);
  assert.match(src, /loginHints = \['login_type', 'pt_login_type', 'tmeLoginType', 'pt_oauth_token'\]/);
  // 日志不输出 gtk 值（避免扩大身份伪造面）
  assert.doesNotMatch(src, /rejected code=' \+ code \+ ' sessionType=' \+ qqLoginSessionType\(\)[\s\S]{0,120}?gtk=/);
  // g_tk 必须优先基于 musickey(qm_keyst/qqmusic_key)计算——写接口严格校验 g_tk，
  // 用 p_skey/skey 计算会在 AddSonglist 等写操作返回 80105（与 L-1124 hash33(musickey) 一致）
  assert.match(src, /const skey = pick\('qm_keyst'\) \|\| pick\('qqmusic_key'\) \|\| pick\('music_key'\) \|\| pick\('skey'\) \|\| pick\('p_skey'\) \|\| pick\('wxskey'\)/);
  assert.match(src, /g_tk 必须基于音乐票据 musickey（qm_keyst\/qqmusic_key）计算/);
  // 写操作前置校验：微信会话直接拦截，OAuth/无 musickey 拦截，标准 QQ 放行
  assert.match(src, /function assertQQWriteSessionSupported\(\)/);
  assert.match(src, /qqMusicSonglistWrite[\s\S]{0,300}?assertQQWriteSessionSupported\(\)/);
  assert.match(src, /handleQQPlaylistCreate[\s\S]{0,200}?assertQQWriteSessionSupported\(\)/);
  assert.match(src, /handleQQPlaylistDelete[\s\S]{0,200}?assertQQWriteSessionSupported\(\)/);
  assert.match(src, /QQ_WECHAT_WRITE_UNSUPPORTED:微信登录仅支持播放与读取/);
  assert.match(src, /QQ_MUSICKEY_REQUIRED:QQ 音乐写操作需要网页版授权/);
  // 80105（会话类型不允许写）显式映射为登录类错误 → HTTP 401
  assert.match(src, /code === 403 \|\| code === 80105\) \{ logQQWriteRejected\(code, result\.variant\); throw new Error\('QQ_AUTH_INCOMPLETE:/);
  assert.doesNotMatch(src, /rejected code=' \+ code \+ ' sessionType=' \+ qqLoginSessionType\(\)[\s\S]{0,180}?uin=/);
  assert.doesNotMatch(src, /rejected code=' \+ code \+ ' sessionType=' \+ qqLoginSessionType\(\)[\s\S]{0,220}?resp=/);
  assert.match(src, /QQ_AUTH_INCOMPLETE:QQ 音乐写操作被当前登录方式拒绝（微信\/OAuth 会话仅支持播放与读取）/);
  // login/status 携带 loginType
  assert.match(src, /loginType: qqLoginSessionType\(cookieObj\)/);
  // 前端状态区引导：loginType 透传 + 微信/OAuth 文案
  assert.match(statusUi, /loginType: info\.loginType \|\| ''/);
  assert.match(statusUi, /if \(info\.loginType === 'wechat'\) return '微信登录仅支持播放与读取/);
  assert.match(statusUi, /if \(info\.loginType === 'oauth'\) return 'OAuth 授权仅支持播放与读取/);
  // 未登录时的 cookie 诊断引导：微信残留 / 缺 uin / 缺 musickey
  assert.match(statusUi, /cookieState: info && info\.cookieState \|\| null/);
  assert.match(statusUi, /if \(cs\.wechatHints\) return '检测到微信登录残留/);
  assert.match(statusUi, /if \(cs\.hasFile && !cs\.hasUin\) return 'QQ 登录未完成/);
  assert.match(src, /cookieState = \{\r?\n\s+hasFile: !!qqCookie,/);
  // /api/qq/login/cookie 拒绝时给出具体缺失字段诊断（uin / qqmusic_key）
  assert.match(src, /const hasUin = !!qqCookieUin\(obj\);\r?\n\s+const hasMusicKey = !!qqCookieMusicKey\(obj\);/);
  assert.match(src, /'Cookie 缺少 ' \+ missing\.join\('、'\)/);
  assert.match(src, /missing\.push\('QQ 账号标识\(uin\)'\)/);
  assert.match(src, /missing\.push\('音乐播放票据\(qqmusic_key\/qm_keyst\)'\)/);
});

test('QQ 写操作 cookie 变体重试行为（80105 切换到下一变体）', async () => {
  // 从 server.js 提取 qqWriteCookieVariants + qqWriteWithVariants，注入 mock qqMusicRequest
  const src = server();
  const vm = require('node:vm');
  function namedSource(name) {
    const idx = src.indexOf(`async function ${name}(`);
    const start = idx >= 0 ? idx : src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', start) + 3;
    return src.slice(start, end);
  }
  const calls = [];
  const sandbox = {
    qqCookie: 'uin=1; qm_keyst=MK',
    qqMusicRequest: async (payload, opts) => {
      calls.push(String(opts && opts.cookie || '').slice(0, 40));
      const seq = calls.length;
      // full → 80105; slim → 0; none → 80105（模拟会话级拒绝）
      const codeMap = { 1: 80105, 2: 0, 3: 80105 };
      return { code: 0, req_0: { code: codeMap[seq] || 0, data: { retCode: 0 } } };
    },
  };
  const script = new vm.Script(
    namedSource('qqWriteCookieVariants') + '\n' +
    namedSource('qqWriteWithVariants') + '\n' +
    'globalThis.__go = () => qqWriteWithVariants(() => ({ comm: {}, req_0: { module: "m", method: "AddSonglist", param: {} } }), { idempotent: true });'
  );
  script.runInNewContext(sandbox);
  const result = await sandbox.__go();
  // 80105 触发变体切换：full 失败后 slim 成功 → 返回 slim 结果
  assert.strictEqual(result.variant, 'slim');
  assert.strictEqual(result.code, 0);
  assert.strictEqual(calls.length, 2, '80105 后应尝试 slim 变体');
});

test('QQ 写操作非幂等写网络错误不重试', async () => {
  const src = server();
  const vm = require('node:vm');
  function namedSource(name) {
    const idx = src.indexOf(`async function ${name}(`);
    const start = idx >= 0 ? idx : src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', start) + 3;
    return src.slice(start, end);
  }
  let networkErr = new Error('timeout');
  const sandbox = {
    qqCookie: 'uin=1; qm_keyst=MK',
    qqMusicRequest: async () => { throw networkErr; },
  };
  const script = new vm.Script(
    namedSource('qqWriteCookieVariants') + '\n' +
    namedSource('qqWriteWithVariants') + '\n' +
    'globalThis.__go = () => qqWriteWithVariants(() => ({ comm: {}, req_0: {} }), {});'
  );
  script.runInNewContext(sandbox);
  // idempotent 非 true：网络错误立即抛出，不重试 full/slim/none
  await assert.rejects(() => sandbox.__go(), /timeout/);
});

test('QQ 写操作幂等写网络错误重试三轮后报错', async () => {
  const src = server();
  const vm = require('node:vm');
  function namedSource(name) {
    const idx = src.indexOf(`async function ${name}(`);
    const start = idx >= 0 ? idx : src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', start) + 3;
    return src.slice(start, end);
  }
  let attempts = 0;
  const sandbox = {
    qqCookie: 'uin=1; qm_keyst=MK',
    qqMusicRequest: async () => { attempts += 1; throw new Error('network-down'); },
  };
  const script = new vm.Script(
    namedSource('qqWriteCookieVariants') + '\n' +
    namedSource('qqWriteWithVariants') + '\n' +
    'globalThis.__go = () => qqWriteWithVariants(() => ({ comm: {}, req_0: {} }), { idempotent: true });'
  );
  script.runInNewContext(sandbox);
  await assert.rejects(() => sandbox.__go(), /network-down/);
  assert.strictEqual(attempts, 3, '幂等写应重试 full/slim/none 三轮');
});

test('合并歌单本地收藏：存储、快照合并、详情移除与 QQ 收藏失败提示', () => {
  const merged = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  const actions = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
  // 本地收藏存储与虚拟来源
  assert.match(merged, /var MERGED_LOCAL_COLLECT_STORE_KEY = 'mineradio-merged-local-collect-v1'/);
  assert.match(merged, /var MERGED_LOCAL_COLLECT_SOURCE_ID = 'local-collect'/);
  assert.match(merged, /function mergedAddLocalCollectSong\(song\)/);
  assert.match(merged, /function mergedRemoveLocalCollectSong\(song\)/);
  assert.match(merged, /function mergedLocalCollectSource\(\)/);
  assert.match(merged, /entry\.sourcePlaylistId = MERGED_LOCAL_COLLECT_SOURCE_ID;/);
  assert.match(merged, /entry\.localCollect = true;/);
  // 快照组装时合并本地收藏 source
  assert.match(merged, /var localCollect = mergedLocalCollectSource\(\);\r?\n\s+if \(localCollect && localCollect\.tracks\.length\) currentSources\.push\(localCollect\);/);
  // 详情：本地收藏来源解析与移除走本地删除
  assert.match(detail, /if \(provider === MERGED_PLAYLIST_PROVIDER && pid === MERGED_LOCAL_COLLECT_SOURCE_ID\) \{\r?\n\s+if \(typeof mergedRemoveLocalCollectSong === 'function'\) mergedRemoveLocalCollectSong\(song\);/);
  assert.match(detail, /已从合并歌单移除（本地收藏）/);
  // 行按钮：本地收藏歌曲显示移除按钮（无需平台 adapter）
  assert.match(detail, /mergedSrc\.provider === MERGED_PLAYLIST_PROVIDER \? mergedSrc\.id === MERGED_LOCAL_COLLECT_SOURCE_ID : !!adapter\.playlistRemoveUrl/);
  // QQ 收藏失败：提示"暂未实现"并自动加入合并歌单
  assert.match(actions, /if \(provider === 'qq'\) \{\r?\n\s+var localOk = false;/);
  assert.match(actions, /localOk = mergedAddLocalCollectSong\(targetSong\);/);
  assert.match(actions, /同步到 QQ 音乐暂未实现，已加入合并歌单（本地收藏）/);
});

test('合并歌单本地收藏运行时：加入→快照组装→移除', () => {
  const fsx = require('node:fs');
  const vm = require('node:vm');
  const src = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  // 提取本地收藏相关函数（纯函数，无外部依赖）
  function namedSource(name) {
    const idx = src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', idx) + 3;
    return src.slice(idx, end);
  }
  const store = {};
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    MERGED_PLAYLIST_PROVIDER: 'merged',
  };
  const script = new vm.Script(
    'var MERGED_PLAYLIST_PROVIDER = "merged";' +
    'var MERGED_LOCAL_COLLECT_SOURCE_ID = "local-collect";' +
    'var MERGED_LOCAL_COLLECT_STORE_KEY = "mineradio-merged-local-collect-v1";' +
    namedSource('readMergedLocalCollectSongs') +
    namedSource('saveMergedLocalCollectSongs') +
    namedSource('mergedLocalCollectKey') +
    namedSource('mergedAddLocalCollectSong') +
    namedSource('mergedRemoveLocalCollectSong') +
    namedSource('mergedLocalCollectSource') +
    'globalThis.__t = { add: mergedAddLocalCollectSong, remove: mergedRemoveLocalCollectSong, source: mergedLocalCollectSource, read: readMergedLocalCollectSongs };'
  );
  script.runInNewContext(sandbox);
  // 加入两首（一首重复）→ 快照 source 包含两首去重
  sandbox.__t.add({ id: '111', name: 'A', artist: 'a1', provider: 'qq' });
  sandbox.__t.add({ id: '111', name: 'A', artist: 'a1', provider: 'qq' });
  sandbox.__t.add({ id: '222', name: 'B', artist: 'b1', provider: 'netease' });
  const source = sandbox.__t.source();
  assert.strictEqual(source.id, 'local-collect');
  assert.strictEqual(source.tracks.length, 2, '重复歌曲应去重');
  assert.strictEqual(source.tracks[0].sourcePlaylistId, 'local-collect');
  assert.strictEqual(source.tracks[0].sourcePlaylistProvider, 'merged');
  assert.strictEqual(source.tracks[0].localCollect, true);
  // 移除一首 → source 剩一首
  sandbox.__t.remove({ id: '111', name: 'A', provider: 'qq' });
  assert.strictEqual(sandbox.__t.source().tracks.length, 1);
  assert.strictEqual(sandbox.__t.source().tracks[0].id, '222');
});

test('合并歌单本地收藏：持久化失败时返回 false', () => {
  const vm = require('node:vm');
  const src = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  function namedSource(name) {
    const idx = src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', idx) + 3;
    return src.slice(idx, end);
  }
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('QUOTA_EXCEEDED'); },
    },
    MERGED_PLAYLIST_PROVIDER: 'merged',
  };
  const script = new vm.Script(
    'var MERGED_PLAYLIST_PROVIDER = "merged";' +
    'var MERGED_LOCAL_COLLECT_SOURCE_ID = "local-collect";' +
    'var MERGED_LOCAL_COLLECT_STORE_KEY = "mineradio-merged-local-collect-v1";' +
    namedSource('readMergedLocalCollectSongs') +
    namedSource('saveMergedLocalCollectSongs') +
    namedSource('mergedLocalCollectKey') +
    namedSource('mergedAddLocalCollectSong') +
    'globalThis.__add = mergedAddLocalCollectSong;'
  );
  script.runInNewContext(sandbox);

  assert.strictEqual(sandbox.__add({ id: 'quota-song', name: '写入失败', provider: 'qq' }), false);
});

test('QQ 喜欢：直接使用合并歌单本地收藏，不调用 QQ like 接口', () => {
  const actions = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
  const merged = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  const toggleStart = actions.indexOf('async function toggleLikeSong(');
  const toggleEnd = actions.indexOf('function toggleLikeCurrent', toggleStart);
  const toggle = actions.slice(toggleStart, toggleEnd);
  const qqBranchStart = toggle.indexOf("if (provider === 'qq')");
  const loginCheck = toggle.indexOf('if (!ensureLoggedInForAction(provider))');
  assert.match(merged, /function mergedHasLocalCollectSong\(song\)/);
  assert.ok(qqBranchStart >= 0, 'QQ 喜欢必须有独立本地收藏分支');
  assert.ok(loginCheck > qqBranchStart, 'QQ 本地收藏分支必须先于登录检查');
  const qqBranch = toggle.slice(qqBranchStart, loginCheck);
  assert.match(qqBranch, /mergedAddLocalCollectSong\(song\)/);
  assert.match(qqBranch, /mergedRemoveLocalCollectSong\(song\)/);
  assert.match(qqBranch, /QQ 音乐同步暂未实现，已加入合并歌单（本地收藏）/);
  assert.match(qqBranch, /已从合并歌单移除（本地收藏）/);
  assert.doesNotMatch(qqBranch, /apiJson\(adapter\.likeUrl/);
});

test('merged playlist catalog refreshes after local collect sync', () => {
  const loaders = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
  assert.match(loaders, /function refreshMergedPlaylistCatalogFromSnapshot\(snapshot, reason\)/);
  assert.match(loaders, /refreshMergedPlaylistCatalogFromSnapshot\(result && result\.snapshot, reason\);/);
  assert.match(loaders, /userPlaylists = userPlaylists\.map\(function \(playlist\) \{[\s\S]{0,500}?buildMergedPlaylistRecord\(playlist\.sources \|\| \[\]\)/);
  assert.match(loaders, /playlistCatalogRevision \+= 1;[\s\S]{0,180}?renderUserPlaylistsList\(\{ animate: false, preserveScroll: true \}\)/);
});

test('merged playlist cache matching ignores the virtual local collect source', () => {
  const merged = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  assert.match(merged, /var snapshotSources = snapshot\.sources\.filter\(function \(source\) \{[\s\S]{0,240}?MERGED_LOCAL_COLLECT_SOURCE_ID/);
  assert.match(merged, /rows\.length !== snapshotSources\.length/);
  assert.match(merged, /snapshotSources\.forEach\(function \(source\)/);
});

test('merged local collect removal clears the like state and refreshes controls', async () => {
  const vm = require('node:vm');
  const src = detail();
  const start = src.indexOf('async function removeSongFromSourcePlaylist(');
  const end = src.indexOf('\n}\n', start) + 3;
  const sandbox = {
    MERGED_PLAYLIST_PROVIDER: 'merged',
    MERGED_LOCAL_COLLECT_SOURCE_ID: 'local-collect',
    likedSongMap: { 'qq:q1': true },
    songAccountStateKey: () => 'qq:q1',
    mergedRemoveLocalCollectSong: () => true,
    markMergedPlaylistDirty: () => Promise.resolve(),
    showToast: () => {},
    miniQueueOpen: false,
    updateLikeButtons: () => { sandbox.updateCalls += 1; },
    safeRenderQueuePanel: () => { sandbox.queueCalls += 1; },
    refreshSearchResultActionStates: () => { sandbox.searchCalls += 1; },
    updateCalls: 0,
    queueCalls: 0,
    searchCalls: 0,
  };
  const script = new vm.Script(
    src.slice(start, end) +
    'globalThis.__remove = removeSongFromSourcePlaylist;'
  );
  script.runInNewContext(sandbox);

  const result = await sandbox.__remove(
    { id: 'q1', provider: 'qq', name: 'Song' },
    { provider: 'merged', id: 'local-collect', merged: true }
  );
  assert.strictEqual(result, true);
  assert.strictEqual(sandbox.likedSongMap['qq:q1'], false);
  assert.strictEqual(sandbox.updateCalls, 1);
  assert.strictEqual(sandbox.queueCalls, 1);
  assert.strictEqual(sandbox.searchCalls, 1);
});

test('unsupported playlist deletion keeps the button and reports capability', () => {
  const core = read('public/js/modules/04-shelf/01-manager-core.js');
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  assert.match(core, /function shelfPlaylistCanDelete\(item\)[\s\S]*?if \(item\.virtual \|\| item\.specialType === 5 \|\| item\.subscribed\) return false;[\s\S]*?return true;/);
  assert.match(detail, /var deleteButton = canDelete\s*\n\s*\? '<button class="fx-mini-btn ghost pl-detail-top-btn pl-detail-delete-btn"/);
  assert.match(detail, /if \(!adapter \|\| !adapter\.playlistDeleteUrl\) \{\n\s+showToast\(playlistProviderName\(provider\) \+ '暂不支持删除歌单'/);
});

test('merged QQ removal is local-only and persists a filtered source track', () => {
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  const merged = read('public/js/modules/06-lyrics/01a-merged-playlist.js');
  const start = detail.indexOf('async function removeSongFromSourcePlaylist(');
  const end = detail.indexOf('\nasync function removeDetailPlaylistTrack(', start);
  const remove = detail.slice(start, end);
  assert.match(remove, /if \(source\.merged && provider === 'qq'\)/);
  assert.match(remove, /mergedAddLocalRemoval\(song, source\)/);
  const qqBranch = remove.slice(remove.indexOf("if (source.merged && provider === 'qq')"), remove.indexOf('try {'));
  assert.doesNotMatch(qqBranch, /apiJson\(adapter\.playlistRemoveUrl/);
  assert.match(merged, /MERGED_LOCAL_REMOVE_STORE_KEY/);
  assert.match(merged, /function mergedAddLocalRemoval\(song, source\)/);
  assert.match(merged, /filterMergedLocallyRemovedTracks/);
});

test('merged local removal is isolated by account and filters rebuilt tracks', () => {
  const vm = require('node:vm');
  const src = merged();
  function namedSource(name) {
    const idx = src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', idx) + 3;
    return src.slice(idx, end);
  }
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
    },
    currentMergedPlaylistAccountKey: () => 'qq:account-a',
  };
  const script = new vm.Script(
    'var MERGED_LOCAL_REMOVE_STORE_KEY = "mineradio-merged-local-removals-v1";' +
    namedSource('normalizeMergedText') +
    namedSource('mergedTrackProviderId') +
    namedSource('mergedTrackMetaKey') +
    namedSource('mergedTrackRemovalIdentity') +
    namedSource('mergedLocalRemovalKey') +
    namedSource('readMergedLocalRemovals') +
    namedSource('saveMergedLocalRemovals') +
    namedSource('mergedTrackLocallyRemoved') +
    namedSource('filterMergedLocallyRemovedTracks') +
    namedSource('mergedAddLocalRemoval') +
    'globalThis.__add = mergedAddLocalRemoval; globalThis.__filter = filterMergedLocallyRemovedTracks;'
  );
  script.runInNewContext(sandbox);
  const song = { id: 'qq-song-1', provider: 'qq', name: 'A', artist: 'B' };
  const source = { provider: 'qq', id: 'qq-playlist-1' };
  assert.strictEqual(sandbox.__add(song, source), true);
  assert.strictEqual(sandbox.__filter([song, { id: 'qq-song-2', provider: 'qq', name: 'C', artist: 'D' }], source).length, 1);
  sandbox.currentMergedPlaylistAccountKey = () => 'qq:account-b';
  assert.strictEqual(sandbox.__filter([song], source).length, 1);
});

test('every removable playlist track keeps a remove action in liked contexts', () => {
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  const content = read('public/js/modules/04-shelf/03-content-list-manager.js');
  assert.match(detail, /canRemove = !!adapter\.playlistRemoveUrl;/);
  assert.doesNotMatch(detail, /canRemove = !isDetailPlaylistLikedContext\(\) && !!adapter\.playlistRemoveUrl;/);
  assert.doesNotMatch(content, /if \(contentIsLikedContext\(\)\) return false;/);
});

test('removing a liked playlist track calls the unlike flow after source removal', () => {
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  assert.match(detail, /async function unlikeSongAfterPlaylistRemove\(song\)/);
  assert.match(detail, /var unlikeOk = await unlikeSongAfterPlaylistRemove\(song\);/);
  assert.match(detail, /if \(source\.liked\)[\s\S]{0,260}?likedSongMap\[key\] = true;/);
  assert.match(detail, /歌曲已移出歌单，但取消红心失败/);
});

test('unlike helper clears a still-liked song after playlist removal', async () => {
  const vm = require('node:vm');
  const src = detail();
  const start = src.indexOf('async function unlikeSongAfterPlaylistRemove(');
  const end = src.indexOf('\n}\n', start) + 3;
  const sandbox = {
    liked: true,
    isSongLiked: () => sandbox.liked,
    toggleLikeSong: async () => { sandbox.toggleCalls += 1; sandbox.liked = false; },
    showToast: (message) => sandbox.messages.push(message),
    toggleCalls: 0,
    messages: [],
  };
  const script = new vm.Script(src.slice(start, end) + 'globalThis.__unlike = unlikeSongAfterPlaylistRemove;');
  script.runInNewContext(sandbox);
  assert.strictEqual(await sandbox.__unlike({ id: 'n1', provider: 'netease' }), true);
  assert.strictEqual(sandbox.toggleCalls, 1);
  assert.strictEqual(sandbox.liked, false);
  assert.deepStrictEqual(sandbox.messages, []);
});

test('source removal unlikes an already-liked ordinary playlist song', async () => {
  const vm = require('node:vm');
  const src = detail();
  const helperStart = src.indexOf('async function unlikeSongAfterPlaylistRemove(');
  const helperEnd = src.indexOf('\n}\n', helperStart) + 3;
  const removeStart = src.indexOf('async function removeSongFromSourcePlaylist(');
  const removeEnd = src.indexOf('\nasync function removeDetailPlaylistTrack(', removeStart);
  const sandbox = {
    MERGED_PLAYLIST_PROVIDER: 'merged',
    MERGED_LOCAL_COLLECT_SOURCE_ID: 'local-collect',
    likedSongMap: { 'netease:n1': true },
    miniQueueOpen: false,
    songAccountStateKey: () => 'netease:n1',
    songAccountId: () => 'n1',
    songAccountAdapter: () => ({ label: '网易云音乐', playlistRemoveUrl: '/api/playlist/remove-song' }),
    playlistProviderName: () => '网易云音乐',
    ensureLoggedInForAction: () => true,
    isSongLiked: (song) => !!sandbox.likedSongMap[sandbox.songAccountStateKey(song)],
    toggleLikeSong: async (song) => {
      sandbox.likeCalls += 1;
      sandbox.likedSongMap[sandbox.songAccountStateKey(song)] = false;
    },
    apiJson: async (url) => { sandbox.apiCalls.push(url); return { success: true }; },
    markMergedPlaylistDirty: () => Promise.resolve(),
    showToast: (message) => sandbox.messages.push(message),
    updateLikeButtons: () => {},
    safeRenderQueuePanel: () => {},
    refreshSearchResultActionStates: () => {},
    likeCalls: 0,
    apiCalls: [],
    messages: [],
  };
  const script = new vm.Script(
    src.slice(helperStart, helperEnd) + src.slice(removeStart, removeEnd) +
    'globalThis.__remove = removeSongFromSourcePlaylist;'
  );
  script.runInNewContext(sandbox);
  const result = await sandbox.__remove(
    { id: 'n1', provider: 'netease', name: 'Song' },
    { provider: 'netease', id: 'playlist-1', merged: false, liked: false }
  );
  assert.strictEqual(result, true);
  assert.deepStrictEqual(sandbox.apiCalls, ['/api/playlist/remove-song']);
  assert.strictEqual(sandbox.likeCalls, 1);
  assert.strictEqual(sandbox.likedSongMap['netease:n1'], false);
  assert.match(sandbox.messages.at(-1), /已从歌单移除/);
});
