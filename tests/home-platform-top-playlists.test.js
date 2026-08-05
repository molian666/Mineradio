'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const dashboardScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'),
  'utf8',
);
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');
const kugouSource = fs.readFileSync(path.join(appRoot, 'kugou-api.js'), 'utf8');
const spotifySource = fs.readFileSync(path.join(appRoot, 'spotify-api.js'), 'utf8');
const qishuiSource = fs.readFileSync(path.join(appRoot, 'qishui-api.js'), 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return '';
}

test('platform recommendation window keeps per-platform tabs', () => {
  for (const source of ['netease', 'qishui', 'qq', 'kugou', 'spotify']) {
    assert.match(indexHtml, new RegExp(`data-home-recommend-source="${source}"`));
  }
});

test('chart entry opens hot charts mode; radio entry opens playlist mode', () => {
  const openCharts = namedFunctionSource(dashboardScript, 'openHomeDashboardCharts');
  assert.match(openCharts, /mode\s*=\s*['"]charts['"]/);
  assert.match(openCharts, /openHomePlatformRecommendations\s*\(\s*['"]netease['"]\s*\)/);
  assert.doesNotMatch(openCharts, /runHomeSearch|今日热歌/);

  const openRadio = namedFunctionSource(dashboardScript, 'openHomeDashboardRadio');
  assert.match(openRadio, /mode\s*=\s*['"]radio['"]/);
  assert.match(openRadio, /openHomePlatformRecommendations\s*\(/);
  assert.doesNotMatch(openRadio, /runHomeSearch|通勤|深夜|专注|私人电台/);

  assert.match(dashboardScript, /mode:\s*['"]radio['"]/);
  assert.match(dashboardScript, /tops:\s*\{/);
  assert.match(dashboardScript, /playlists:\s*\{/);
});

test('hot charts config maps every platform to a real top endpoint without keyword search', () => {
  const topConfig = namedFunctionSource(dashboardScript, 'homePlatformTopConfig');
  assert.ok(topConfig, 'expected homePlatformTopConfig()');
  for (const endpoint of [
    '/api/netease/top',
    '/api/kugou/top',
    '/api/qq/top',
    '/api/spotify/top',
    '/api/qishui/top',
  ]) {
    assert.match(topConfig, new RegExp(endpoint.replace(/[-/]/g, '\\$&')));
  }
  assert.doesNotMatch(topConfig, /search|keyword|关键词/);
});

test('playlist config maps every non-netease platform to a real playlist endpoint', () => {
  const playlistsConfig = namedFunctionSource(dashboardScript, 'homePlatformPlaylistsConfig');
  assert.ok(playlistsConfig, 'expected homePlatformPlaylistsConfig()');
  for (const endpoint of [
    '/api/kugou/playlists/recommend',
    '/api/qq/playlists/recommend',
    '/api/spotify/playlists/featured',
    '/api/qishui/playlists/recommend',
  ]) {
    assert.match(playlistsConfig, new RegExp(endpoint.replace(/[-/]/g, '\\$&')));
  }
  assert.doesNotMatch(playlistsConfig, /search|keyword|关键词/);
});

test('renderer switches modal title between hot charts and playlist modes', () => {
  const render = namedFunctionSource(dashboardScript, 'renderHomePlatformRecommendations');
  assert.match(render, /home-platform-recommend-title/);
  assert.match(render, /平台热歌榜/);
  assert.match(render, /平台推荐/);
  assert.match(render, /renderHomePlatformTopContent/);
  assert.match(render, /-playlist/);
  assert.match(render, /liked-affinity/);
  assert.match(render, /personal-top/);
  const topContent = namedFunctionSource(dashboardScript, 'renderHomePlatformTopContent');
  assert.ok(topContent, 'expected renderHomePlatformTopContent()');
  assert.match(topContent, /renderHomePlatformTopWindow/);
  const topWindow = namedFunctionSource(dashboardScript, 'renderHomePlatformTopWindow');
  assert.ok(topWindow, 'expected renderHomePlatformTopWindow()');
  assert.match(topWindow, /-top-song/);
});

test('hot charts loaders fetch their platform endpoint and keep explicit empty states', () => {
  const topLoader = namedFunctionSource(dashboardScript, 'loadHomePlatformTopRecommendations');
  assert.match(topLoader, /apiJson\s*\(\s*config\.endpoint/);
  assert.match(topLoader, /topState\.songs/);
  const topContent = namedFunctionSource(dashboardScript, 'renderHomePlatformTopContent');
  assert.match(topContent, /QISHUI_TOP_UNAVAILABLE/);
  assert.match(topContent, /未使用关键词搜索/);

  const playlistsLoader = namedFunctionSource(dashboardScript, 'loadHomePlatformPlaylistRecommendations');
  assert.match(playlistsLoader, /apiJson\s*\(\s*config\.endpoint/);
  assert.match(playlistsLoader, /playlistsState\.playlists/);
});

test('opening a recommended playlist uses the provider-prefixed playlist loader', () => {
  const opener = namedFunctionSource(dashboardScript, 'openHomePlatformPlaylist');
  assert.ok(opener, 'expected openHomePlatformPlaylist()');
  assert.match(opener, /loadPlaylistIntoQueueById/);
  assert.match(opener, /source\s*\+\s*['"]:['"]\s*\+\s*id/);
  assert.doesNotMatch(opener, /runHomeSearch|关键词/);
});

test('server exposes per-platform top and recommended playlist routes', () => {
  for (const pn of [
    '/api/netease/top',
    '/api/kugou/top',
    '/api/qq/top',
    '/api/spotify/top',
    '/api/qishui/top',
    '/api/kugou/playlists/recommend',
    '/api/qq/playlists/recommend',
    '/api/spotify/playlists/featured',
    '/api/qishui/playlists/recommend',
  ]) {
    assert.match(serverSource, new RegExp(`pn\\s*===\\s*['"]${pn.replace(/[-/]/g, '\\$&')}['"]`));
  }
});

test('netease hot songs use the fixed hot list playlist and map upstream songs', () => {
  assert.match(serverSource, /NETEASE_HOT_SONGS_PLAYLIST_ID\s*=\s*3778678/);
  const handler = namedFunctionSource(serverSource, 'handleNeteaseTopSongs');
  assert.ok(handler, 'expected handleNeteaseTopSongs()');
  assert.match(handler, /top_list\s*\(\s*\{/);
  assert.match(handler, /NETEASE_HOT_SONGS_PLAYLIST_ID/);
  assert.match(handler, /mapSongRecord/);
});

test('qq hot songs use the public hot top chart and fail closed without auth hacks', () => {
  const handler = namedFunctionSource(serverSource, 'handleQQTopSongs');
  assert.ok(handler, 'expected handleQQTopSongs()');
  assert.match(handler, /fcg_v8_toplist_cp\.fcg/);
  assert.match(handler, /topid:\s*'26'/);
});

test('qq recommended playlists use the free plaza endpoint without login or search', () => {
  const playlistsHandler = namedFunctionSource(serverSource, 'handleQQRecommendPlaylists');
  assert.match(playlistsHandler, /get_playlist_by_category/);
  assert.match(playlistsHandler, /PlayListPlazaServer/);
  assert.match(playlistsHandler, /mapQQPlazaPlaylist/);
  assert.doesNotMatch(playlistsHandler, /QQ_AUTH_REQUIRED/);
  assert.match(playlistsHandler, /未使用关键词搜索补位/);
});

test('kugou top and playlists use public endpoints and keep cover/hash mapping', () => {
  const topHandler = namedFunctionSource(kugouSource, 'handleKugouTop');
  assert.match(topHandler, /mobilecdn\.kugou\.com\/api\/v3\/rank\/song/);
  assert.match(topHandler, /rankid=8888/);
  assert.match(topHandler, /mapKugouRankSong/);
  const rankMapper = namedFunctionSource(kugouSource, 'mapKugouRankSong');
  assert.match(rankMapper, /album_sizable_cover/);
  assert.match(rankMapper, /hash/);
  const plHandler = namedFunctionSource(kugouSource, 'handleKugouRecommendPlaylists');
  assert.match(plHandler, /plist\/index/);
  assert.match(plHandler, /mapKugouPlistItem/);
});

test('spotify top reads the official Global Top 50 playlist; featured uses browse endpoint', () => {
  assert.match(spotifySource, /SPOTIFY_GLOBAL_TOP50_PLAYLIST_ID\s*=\s*['"]37i9dQZEVXbMDoHDwVN2tF['"]/);
  const topHandler = namedFunctionSource(spotifySource, 'handleSpotifyTop');
  assert.match(topHandler, /SPOTIFY_GLOBAL_TOP50_PLAYLIST_ID/);
  assert.match(topHandler, /\/v1\/playlists\//);
  const featured = namedFunctionSource(spotifySource, 'handleSpotifyFeaturedPlaylists');
  assert.match(featured, /\/v1\/browse\/featured-playlists/);
  assert.match(featured, /mapSpotifyPlaylist/);
});

test('qishui top and playlists explicitly stay empty instead of searching', () => {
  const topHandler = namedFunctionSource(qishuiSource, 'handleQishuiTop');
  assert.match(topHandler, /QISHUI_TOP_UNAVAILABLE/);
  assert.match(topHandler, /未使用关键词搜索替代/);
  const plHandler = namedFunctionSource(qishuiSource, 'handleQishuiRecommendPlaylists');
  assert.match(plHandler, /QISHUI_PLAYLIST_UNAVAILABLE/);
  assert.doesNotMatch(topHandler + plHandler, /apiJson|search\s*\(/);
});

test('playable hot songs are exposed through the existing card click pipeline', () => {
  const bind = namedFunctionSource(dashboardScript, 'bindHomePlatformRecommendationControls');
  assert.match(bind, /-top-song/);
  assert.match(bind, /playHomePlatformTopSongs/);
  assert.match(bind, /-playlist/);
  assert.match(bind, /openHomePlatformPlaylist/);
});

test('hot charts endpoints load full lists without a limit cap', () => {
  const topConfig = namedFunctionSource(dashboardScript, 'homePlatformTopConfig');
  assert.doesNotMatch(topConfig, /limit/);
  const neteaseHandler = namedFunctionSource(serverSource, 'handleNeteaseTopSongs');
  assert.match(neteaseHandler, /hasLimit/);
  const qqHandler = namedFunctionSource(serverSource, 'handleQQTopSongs');
  assert.match(qqHandler, /song_begin/);
  assert.match(qqHandler, /PAGE/);
});

test('kugou playlists stream page by page and render incrementally', () => {
  assert.match(dashboardScript, /loadHomePlatformKugouPlaylistsStreaming/);
  const streaming = namedFunctionSource(dashboardScript, 'loadHomePlatformKugouPlaylistsStreaming');
  assert.match(streaming, /\/api\/kugou\/playlists\/recommend\?page=/);
  assert.match(streaming, /renderHomePlatformRecommendations\(\)/);
  const handler = namedFunctionSource(kugouSource, 'handleKugouRecommendPlaylists');
  assert.match(handler, /opts\.page/);
  assert.match(handler, /hasMore/);
});

test('every platform has a daily recommendation block in playlist mode', () => {
  const feedConfig = namedFunctionSource(dashboardScript, 'homePlatformRecommendationFeedConfig');
  assert.match(feedConfig, /sectionTitle:\s*'每日推荐'/);
  const dailyConfig = namedFunctionSource(dashboardScript, 'homePlatformDailyConfig');
  assert.match(dailyConfig, /\/api\/qq\/daily/);
  assert.match(dashboardScript, /daily:\s*\{/);
  const render = namedFunctionSource(dashboardScript, 'renderHomePlatformRecommendations');
  assert.match(render, /-daily-song/);
  const bind = namedFunctionSource(dashboardScript, 'bindHomePlatformRecommendationControls');
  assert.match(bind, /playHomePlatformDailySongs/);
});

test('qq daily recommendations use the web recommend module, never search', () => {
  assert.match(serverSource, /pn\s*===\s*['"]\/api\/qq\/daily['"]/);
  const handler = namedFunctionSource(serverSource, 'handleQQDailyRecommendations');
  assert.match(handler, /music\.web_srf_svr/);
  assert.match(handler, /get_recommend/);
  assert.match(handler, /QQ_AUTH_REQUIRED/);
  assert.match(handler, /未使用关键词搜索替代/);
  assert.doesNotMatch(handler, /apiJson|search\s*\(/);
  const mapper = namedFunctionSource(serverSource, 'mapQQDailySong');
  assert.ok(mapper, 'expected mapQQDailySong()');
  const extractor = namedFunctionSource(serverSource, 'extractQQDailySongs');
  assert.ok(extractor, 'expected extractQQDailySongs()');
  assert.match(extractor, /Object\.keys/);
  assert.match(extractor, /artist \|\| s\.album/);
  const gtk = namedFunctionSource(serverSource, 'qqMusicGtk');
  assert.ok(gtk, 'expected qqMusicGtk()');
  assert.match(gtk, /skey|qm_keyst/);
  const newSongs = namedFunctionSource(serverSource, 'fetchQQNewSongs');
  assert.ok(newSongs, 'expected fetchQQNewSongs()');
  assert.match(newSongs, /NewSongServer/);
  assert.doesNotMatch(serverSource, /fetchQQDailyPlaylistIdFromMac|musicmac/);
});

test('qq daily song extractor handles both snake and camel song lists', () => {
  const sandbox = { qqAlbumCover: function () { return ''; } };
  const script = new vm.Script(
    namedFunctionSource(serverSource, 'mapQQDailySong') + '\n' +
    namedFunctionSource(serverSource, 'extractQQDailySongs') + '\n' +
    'globalThis.__run = (block) => extractQQDailySongs(block, 0);'
  );
  script.runInNewContext(sandbox);
  const camelResponse = {
    code: 0,
    data: { recommend: { songInfo: [
      { name: '甲', mid: 'm1', singer: [{ id: 1, mid: 's1', name: '歌手甲' }], album: { mid: 'al1', name: '专辑甲' } },
    ] } },
  };
  const snakeResponse = {
    code: 0,
    data: { songlist: [
      { name: '乙', mid: 'm2', singer: [{ id: 2, mid: 's2', name: '歌手乙' }], album: { mid: 'al2', name: '专辑乙' } },
    ] },
  };
  const fromCamel = sandbox.__run(camelResponse);
  const fromSnake = sandbox.__run(snakeResponse);
  assert.equal(fromCamel.length, 1);
  assert.equal(fromCamel[0].name, '甲');
  assert.equal(fromCamel[0].artist, '歌手甲');
  assert.equal(fromSnake.length, 1);
  assert.equal(fromSnake[0].name, '乙');
});
