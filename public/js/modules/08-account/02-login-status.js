function readProviderVipAuditState() {
  try {
    var raw = localStorage.getItem(PROVIDER_VIP_AUDIT_STORE_KEY) || '{}';
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}
function writeProviderVipAuditState(state) {
  try { localStorage.setItem(PROVIDER_VIP_AUDIT_STORE_KEY, JSON.stringify(state || {})); } catch (e) { }
}
var QQ_PLAYBACK_VIP_EVIDENCE_TTL_MS = 12 * 60 * 60 * 1000;
function qqPlaybackVipEvidenceUserKey(status) {
  return String(status && (status.userId || status.uin || status.uid || status.openId || status.id) || '').trim();
}
function readQQPlaybackVipEvidence() {
  try {
    var raw = localStorage.getItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY) || '{}';
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}
function writeQQPlaybackVipEvidence(evidence) {
  try { localStorage.setItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY, JSON.stringify(evidence || {})); } catch (e) { }
}
function clearQQPlaybackVipEvidence() {
  try { localStorage.removeItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY); } catch (e) { }
}
function qqPlaybackVipEvidenceApplies(evidence, status) {
  if (!evidence || !status || !status.loggedIn) return false;
  var checkedAt = Number(evidence.checkedAt || evidence.vipCheckedAt || 0) || 0;
  if (!checkedAt || Date.now() - checkedAt > QQ_PLAYBACK_VIP_EVIDENCE_TTL_MS) return false;
  var evidenceUser = qqPlaybackVipEvidenceUserKey(evidence);
  var statusUser = qqPlaybackVipEvidenceUserKey(status);
  return !!(evidenceUser && statusUser && evidenceUser === statusUser);
}
function mergeQQPlaybackVipEvidence(status) {
  if (!status || !status.loggedIn) return status;
  var evidence = readQQPlaybackVipEvidence();
  if (!qqPlaybackVipEvidenceApplies(evidence, status)) return status;
  var svip = providerVipLevel('qq', status) === 'svip' || providerVipLevel('qq', evidence) === 'svip' || !!status.isSvip || !!evidence.isSvip;
  return Object.assign({}, status, {
    provider: 'qq',
    loggedIn: true,
    vipType: Math.max(Number(status.vipType || status.vip_type || 0) || 0, Number(evidence.vipType || evidence.vip_type || 0) || 0, 1),
    svipType: Math.max(Number(status.svipType || status.svip_type || 0) || 0, Number(evidence.svipType || evidence.svip_type || 0) || 0),
    vipLevel: svip ? 'svip' : 'vip',
    isVip: true,
    isSvip: svip,
    playbackKeyReady: true,
    vipCheckedAt: Math.max(Number(status.vipCheckedAt || 0) || 0, Number(evidence.checkedAt || evidence.vipCheckedAt || 0) || 0),
    vipSource: evidence.vipSource || status.vipSource || 'qq-playback-evidence',
    vipProbeAvailable: true,
    membershipStale: false,
    authorizationIncomplete: false,
    vipSyncState: 'playback_evidence'
  });
}
function providerVipAuditSnapshot(provider, status) {
  status = status || {};
  var level = providerVipLevel(provider, status);
  return {
    provider: provider,
    loggedIn: !!status.loggedIn,
    userId: String(status.userId || status.uid || status.uin || status.openId || status.id || ''),
    vipLevel: level,
    isVip: level !== 'none',
    checkedAt: Date.now()
  };
}
function providerVipAuditLabel(provider, snapshot) {
  var meta = platformMeta(provider);
  var label = meta && meta.label || provider;
  var level = snapshot && snapshot.vipLevel === 'svip' ? 'SVIP' : 'VIP';
  return label + ' ' + level;
}
function providerVipAuditSameUser(previous, current) {
  if (!previous || !current) return true;
  if (!previous.userId || !current.userId) return true;
  return String(previous.userId) === String(current.userId);
}
function auditProviderVipState(provider, status) {
  if (!status) return;
  var state = readProviderVipAuditState();
  var previous = state[provider] || null;
  var current = providerVipAuditSnapshot(provider, status);
  var sameUser = providerVipAuditSameUser(previous, current);
  if (previous && sameUser && previous.loggedIn && previous.isVip && current.loggedIn && !current.isVip) {
    var title = providerVipAuditLabel(provider, previous) + ' 状态掉了';
    var body = '本次启动复验时已变为普通账号，会员曲目可能只能试听或需要换源。';
    if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice(title, body);
    else showToast(title);
  }
  if (previous && sameUser && previous.loggedIn && !previous.isVip && current.loggedIn && current.isVip) {
    var syncTitle = providerVipAuditLabel(provider, current) + ' 已同步';
    var syncBody = '已重新检查到当前账号会员状态，会员曲目会按新的平台权限继续尝试播放。';
    if (typeof showToast === 'function') showToast(syncTitle);
    else if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice(syncTitle, syncBody);
  }
  state[provider] = current;
  writeProviderVipAuditState(state);
}

async function refreshLoginStatus(force) {
  try {
    var info = await apiJson('/api/login/status?t=' + Date.now());
    loginStatusChecked = true;
    loginStatusCheckFailed = false;
    loginStatus = info || { loggedIn: false };
    auditProviderVipState('netease', loginStatus);
    if (loginStatus.loggedIn && !hasPlatformLogin(activeAccountProvider)) activeAccountProvider = 'netease';
    renderUserBtn();
    if (info && info.loggedIn) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
      syncLikeStatusForSongs(playQueue.concat(playlist || []));
    } else {
      neteasePlaylists = [];
      userPlaylists = qqPlaylists.concat(kugouPlaylists || [], qishuiPlaylists || [], spotifyPlaylists || []);
      playlistCatalogRevision += 1;
      myPodcastCollections = [];
      myPodcastItems = {};
      likedSongMap = {};
      updateLikeButtons();
    }
    return info;
  } catch (e) {
    console.warn(e);
    loginStatusChecked = true;
    loginStatusCheckFailed = true;
    renderUserBtn();
    return null;
  }
}

function normalizeQQLoginStatus(info) {
  var fallback = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ 音乐', userId: '', avatar: '', vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, playbackKeyReady: false, loginType: '', vipCheckedAt: 0, vipSource: '', vipProbeAvailable: false, membershipKnown: false, membershipStale: false, authorizationIncomplete: false, vipSyncState: '' };
  if (!info || !info.loggedIn) return Object.assign({}, fallback, info || {}, {
    provider: 'qq',
    loggedIn: false,
    nickname: info && info.nickname || fallback.nickname,
    userId: info && (info.userId || info.uin) || '',
    avatar: info && info.avatar || '',
    vipType: Number(info && (info.vipType || info.vip_type) || 0) || 0,
    svipType: Number(info && (info.svipType || info.svip_type) || 0) || 0,
    vipLevel: info && (info.vipLevel || info.vip_level) || 'none',
    isVip: !!(info && info.isVip),
    isSvip: !!(info && info.isSvip),
    stale: !!info.stale || !!(info.sessionExpired) || !!(info.profileUnavailable && !(info.nickname && info.avatar)),
    sessionExpired: !!(info && info.sessionExpired),
    vipCheckedAt: Number(info && info.vipCheckedAt || 0) || 0,
    vipSource: info && info.vipSource || '',
    vipProbeAvailable: !!(info && info.vipProbeAvailable),
    membershipKnown: !!(info && info.membershipKnown),
    membershipStale: !!(info && info.membershipStale),
    authorizationIncomplete: !!(info && info.authorizationIncomplete),
    loginType: info && info.loginType || '',
    cookieState: info && info.cookieState || null,
    vipSyncState: info && info.vipSyncState || ''
  });
  return Object.assign({}, fallback, info, {
    provider: 'qq',
    // QQ 官方明确返回"需要重新登录"（code 1000 / result 301）时，即使
    // cookie 文件里还有 uin+musicKey，也必须按掉登录处理：否则前端会
    // 一直显示已登录、歌单同步却永远失败（见服务端 getQQLoginInfo）。
    loggedIn: !(info && info.sessionExpired),
    nickname: info.nickname || fallback.nickname,
    userId: info.userId || info.uin || '',
    avatar: info.avatar || '',
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    svipType: Number(info.svipType || info.svip_type || 0) || 0,
    vipLevel: info.vipLevel || info.vip_level || 'none',
    isVip: !!info.isVip,
    isSvip: !!info.isSvip,
    playbackKeyReady: !!info.playbackKeyReady,
    loginType: info.loginType || '',
    stale: !!info.stale || !!(info.sessionExpired) || !!(info.profileUnavailable && !(info.nickname && info.avatar)),
    sessionExpired: !!(info.sessionExpired),
    vipCheckedAt: Number(info.vipCheckedAt || 0) || 0,
    vipSource: info.vipSource || '',
    vipProbeAvailable: !!info.vipProbeAvailable,
    membershipKnown: !!info.membershipKnown,
    membershipStale: !!info.membershipStale,
    authorizationIncomplete: !!info.authorizationIncomplete,
    vipSyncState: info.vipSyncState || ''
  });
}

function qqLoginNeedsAuthorizationRefresh(status) {
  status = status || qqLoginStatus;
  return !!(status && status.loggedIn && (
    status.authorizationIncomplete ||
    status.playbackKeyReady === false
  ));
}
function qqMembershipNeedsSync(status) {
  status = status || qqLoginStatus;
  return !!(status && status.loggedIn && (
    status.membershipKnown !== true ||
    status.membershipStale
  ));
}
function qqMembershipLabel(status) {
  if (qqMembershipNeedsSync(status)) return '会员待同步';
  var level = providerVipLevel('qq', status);
  return level === 'svip' ? 'SVIP 会员' : (level === 'vip' ? 'VIP 会员' : '普通账号');
}
function qqLoginStatusText(info) {
  info = normalizeQQLoginStatus(info || qqLoginStatus);
  if (!info.loggedIn) {
    var cs = info.cookieState || {};
    if (cs.wechatHints) return '检测到微信登录残留 · 请改用 QQ 号扫码登录（微信通道不可用）';
    if (cs.hasFile && !cs.hasUin) return 'QQ 登录未完成 · 请用 QQ 号扫码并等待进入播放器页';
    if (cs.hasFile && !cs.hasMusicKey) return 'QQ 号已连接 · 播放授权未完成，请重新扫码';
    return '点击“扫码登录”打开 QQ 音乐官方窗口（请选 QQ 扫码，非微信）';
  }
  if (info.loginType === 'wechat') return '微信登录仅支持播放与读取 · 红心/歌单写操作请改用 QQ 号扫码登录';
  if (info.loginType === 'oauth') return 'OAuth 授权仅支持播放与读取 · 红心/歌单写操作请改用 QQ 号扫码登录';
  if (qqLoginNeedsAuthorizationRefresh(info)) return 'QQ 网页会话已连接 · 播放授权尚未完成';
  if (qqMembershipNeedsSync(info)) return '已保存 QQ 音乐播放授权 · 会员状态待同步';
  var syncText = info.vipCheckedAt ? ' · 会员已复验' : '';
  return '已保存 QQ 音乐会话 · ' + (info.nickname || 'QQ 音乐') + ' · ' + qqMembershipLabel(info) + syncText;
}

async function refreshQQLoginStatus(options) {
  if (options === true) options = { forceVip: true };
  options = options || {};
  try {
    var query = '/api/qq/login/status?t=' + Date.now() + (options.forceVip ? '&forceVip=1' : '');
    var info = await apiJson(query);
    var prevLogged = !!qqLoginStatus.loggedIn;
    qqLoginStatus = normalizeQQLoginStatus(info);
    auditProviderVipState('qq', qqLoginStatus);
    if (!qqLoginStatus.loggedIn) {
      if (qqLoginStatus.sessionExpired) {
        if (!qqSessionExpiredNotified) { qqSessionExpiredNotified = true; showToast('QQ 音乐登录已失效，请重新登录'); }
      } else if (prevLogged || qqLoginWasLoggedIn) showToast(qqLoginStatus.stale ? 'QQ 音乐登录已失效' : 'QQ 音乐已掉登录');
      qqPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qq'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if ((fx && fx.shelfMergeCollections) ? !qqPlaylists.length : !userPlaylists.some(function (pl) { return pl && pl.provider === 'qq'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      loadHomeDiscover(true);
      refreshUserPlaylists(true);
    } else if (qqLoginStatus.stale) {
      showToast('QQ 音乐登录状态可能已失效');
    }
    if (qqLoginStatus.loggedIn) qqSessionExpiredNotified = false;
    qqLoginWasLoggedIn = !!qqLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return qqLoginStatus;
  } catch (e) {
    console.warn('QQ login status failed:', e);
    if (qqLoginStatus && qqLoginStatus.loggedIn) {
      qqLoginStatus = normalizeQQLoginStatus(Object.assign({}, qqLoginStatus, {
        loggedIn: true,
        stale: true,
        membershipStale: true,
        vipProbeAvailable: false,
        vipSyncState: 'stale'
      }));
    } else {
      qqLoginStatus = normalizeQQLoginStatus(null);
    }
    renderUserBtn();
    return qqLoginStatus;
  }
}
function refreshQQVipStatusNow(reason) {
  var now = Date.now();
  if (now - qqLoginStatusLastForcedAt < 8000) return Promise.resolve(qqLoginStatus);
  qqLoginStatusLastForcedAt = now;
  return refreshQQLoginStatus({ forceVip: true, reason: reason || 'manual' });
}
function startQQLoginStatusAutoRefresh() {
  if (qqLoginAutoRefreshTimer) clearInterval(qqLoginAutoRefreshTimer);
  qqLoginAutoRefreshTimer = setInterval(function () {
    refreshQQLoginStatus({ reason: 'auto' }).catch(function (e) { console.warn('QQ login auto refresh failed:', e); });
  }, 45000);
  if (startQQLoginStatusAutoRefresh._boundFocusRefresh) return;
  startQQLoginStatusAutoRefresh._boundFocusRefresh = true;
  function refreshOnVisible(reason) {
    if (document.hidden) return;
    if (!qqLoginStatus.loggedIn && !qqLoginWasLoggedIn) return;
    refreshQQVipStatusNow(reason).catch(function (e) { console.warn('QQ VIP foreground refresh failed:', e); });
  }
  window.addEventListener('focus', function () { refreshOnVisible('window-focus'); });
  document.addEventListener('visibilitychange', function () { refreshOnVisible('visibility'); });
}

function normalizeKugouLoginStatus(info) {
  var fallback = { provider: 'kugou', loggedIn: false, preview: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, reauthRequired: false, sessionExpired: false, playbackKeyReady: false };
  var normalizedLevel = info && info.loggedIn ? providerVipLevel('kugou', info) : (info && (info.vipLevel || info.vip_level) || 'none');
  if (!info || !info.loggedIn) return Object.assign({}, fallback, info || {}, {
    provider: 'kugou',
    loggedIn: false,
    nickname: info && info.nickname || fallback.nickname,
    userId: info && (info.userId || info.userid) || '',
    avatar: info && info.avatar || '',
    vipType: Number(info && (info.vipType || info.vip_type) || 0) || 0,
    svipType: Number(info && (info.svipType || info.svip_type) || 0) || 0,
    vipLevel: normalizedLevel,
    isVip: normalizedLevel !== 'none' || !!(info && info.isVip),
    isSvip: normalizedLevel === 'svip' || !!(info && info.isSvip),
    stale: !!(info && (info.stale || info.sessionExpired || info.reauthRequired)),
    reauthRequired: !!(info && info.reauthRequired),
    sessionExpired: !!(info && info.sessionExpired),
    playbackKeyReady: !!(info && (info.playbackReady || info.playbackKeyReady))
  });
  return Object.assign({}, fallback, info, {
    provider: 'kugou',
    loggedIn: !(info && info.sessionExpired),
    nickname: info.nickname || fallback.nickname,
    userId: info.userId || info.userid || '',
    avatar: info.avatar || '',
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    svipType: Number(info.svipType || info.svip_type || 0) || 0,
    vipLevel: normalizedLevel,
    isVip: normalizedLevel !== 'none' || !!info.isVip,
    isSvip: normalizedLevel === 'svip' || !!info.isSvip,
    playbackKeyReady: !!(info.playbackReady || info.playbackKeyReady),
    stale: !!info.stale || !!(info.sessionExpired) || !!(info.reauthRequired),
    reauthRequired: !!(info.reauthRequired),
    sessionExpired: !!(info.sessionExpired)
  });
}
function applyKugouPlaybackStatusEvidence(info) {
  if (!info || info.provider !== 'kugou' || !info.loggedIn) return false;
  var existing = kugouLoginStatus || {};
  var verifiedMembership = info.membershipVerified === true &&
    (info.membershipSource === 'kugou-vip-api' ||
      info.membershipSource === 'kugou-web-roleinfo' ||
      info.membershipSource === 'kugou-cookie-explicit');
  var safeUpdate = {
    provider: 'kugou',
    loggedIn: true,
    playbackKeyReady: !!(info.playbackReady || info.playbackKeyReady || existing.playbackKeyReady)
  };
  if (verifiedMembership) {
    safeUpdate.vipType = Number(info.vipType || 0) || 0;
    safeUpdate.svipType = Number(info.svipType || 0) || 0;
    safeUpdate.vipLevel = info.vipLevel === 'svip' ? 'svip' : (info.vipLevel === 'vip' ? 'vip' : 'none');
    safeUpdate.isVip = info.isVip === true;
    safeUpdate.isSvip = info.isSvip === true;
    safeUpdate.membershipVerified = true;
    safeUpdate.membershipSource = info.membershipSource;
  }
  kugouLoginStatus = normalizeKugouLoginStatus(Object.assign({}, existing, safeUpdate));
  kugouLoginWasLoggedIn = true;
  renderUserBtn();
  return true;
}
// QQ VIP 资格安全哨兵（qq-vip-entitlement.test.js 锁定）：可播放 URL 加歌曲级
// VIP 提示只证明请求成功，不证明账号拥有订阅。此函数必须恒返回 false，
// 防止未来误把"能播"当作"已购会员"。当前无调用方，保留作为防御性契约。
function qqPlaybackShowsMemberAccess() {
  return false;
}
async function refreshKugouLoginStatus() {
  try {
    var info = await apiJson('/api/kugou/login/status?t=' + Date.now());
    var prevLogged = !!kugouLoginStatus.loggedIn;
    if (info && info.loggedIn && kugouSessionInvalidated) {
      // 歌单同步已确认会话失效：login/status 只证明 cookie 文件还在，
      // 不代表酷狗服务端会话有效。保持"已失效"直到用户重新登录成功，
      // 避免 45s 自动刷新把状态又刷回"已登录"导致歌单同步反复失败。
      info = Object.assign({}, info, { loggedIn: false, stale: true, reauthRequired: true, sessionExpired: true });
    }
    kugouLoginStatus = normalizeKugouLoginStatus(info);
    auditProviderVipState('kugou', kugouLoginStatus);
    if (!kugouLoginStatus.loggedIn) {
      if (kugouLoginStatus.sessionExpired || kugouLoginStatus.reauthRequired) {
        if (!kugouSessionExpiredNotified) { kugouSessionExpiredNotified = true; showToast('酷狗音乐登录已失效，请重新登录'); }
      } else if (prevLogged || kugouLoginWasLoggedIn) showToast(kugouLoginStatus.stale ? '酷狗音乐登录已失效' : '酷狗音乐已掉登录');
      kugouPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if (typeof kugouPlaylistCatalogNeedsRefresh === 'function' &&
      kugouPlaylistCatalogNeedsRefresh(
        kugouLoginStatus,
        (fx && fx.shelfMergeCollections)
          ? kugouPlaylists.length > 0
          : userPlaylists.some(function (pl) { return pl && pl.provider === 'kugou'; }),
        typeof playlistCatalogProviderSyncFailed === 'function' && playlistCatalogProviderSyncFailed('kugou')
      )) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
    } else if (kugouLoginStatus.stale) {
      showToast('酷狗音乐登录状态可能已失效');
    }
    if (kugouLoginStatus.loggedIn) kugouSessionExpiredNotified = false;
    kugouLoginWasLoggedIn = !!kugouLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return kugouLoginStatus;
  } catch (e) {
    console.warn('Kugou login status failed:', e);
    kugouLoginStatus = normalizeKugouLoginStatus(null);
    renderUserBtn();
    return kugouLoginStatus;
  }
}
// 酷狗歌单同步被平台明确判为"会话失效"（reauthRequired，如 20017）时调用：
// 立即把登录状态标记为失效并提示重新登录，避免"显示已登录但歌单为空"
// 的静默失败（用户只能靠手动重新登录才能恢复同步）。
function markKugouSessionExpired() {
  if (!kugouLoginStatus || !kugouLoginStatus.loggedIn) return;
  kugouSessionInvalidated = true;
  kugouLoginStatus = normalizeKugouLoginStatus(Object.assign({}, kugouLoginStatus, {
    loggedIn: false,
    stale: true,
    reauthRequired: true,
    sessionExpired: true,
    playbackKeyReady: false,
  }));
  kugouLoginWasLoggedIn = false;
  kugouPlaylists = [];
  userPlaylists = userPlaylists.filter(function (pl) { return pl && pl.provider !== 'kugou'; });
  playlistCatalogRevision += 1;
  renderUserBtn();
  if (!kugouSessionExpiredNotified) { kugouSessionExpiredNotified = true; showToast('酷狗音乐登录已失效，请重新登录'); }
}
function startKugouLoginStatusAutoRefresh() {
  if (kugouLoginAutoRefreshTimer) clearInterval(kugouLoginAutoRefreshTimer);
  kugouLoginAutoRefreshTimer = setInterval(function () {
    if (document.hidden) return; // 后台不轮询，可见时 focus/visibility 补刷
    refreshKugouLoginStatus().catch(function (e) { console.warn('Kugou login auto refresh failed:', e); });
  }, 45000);
  if (startKugouLoginStatusAutoRefresh._boundFocusRefresh) return;
  startKugouLoginStatusAutoRefresh._boundFocusRefresh = true;
  function refreshKugouOnVisible() {
    if (document.hidden) return;
    if (!kugouLoginStatus.loggedIn && !kugouLoginWasLoggedIn) return;
    refreshKugouLoginStatus().catch(function (e) { console.warn('Kugou login foreground refresh failed:', e); });
  }
  window.addEventListener('focus', function () { refreshKugouOnVisible(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshKugouOnVisible(); });
}

function normalizeQishuiLoginStatus(info) {
  var fallback = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: '汽水音乐', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, sessionExpired: false, playbackKeyReady: false, playbackMode: 'recommend-match', searchReady: false, publicCatalog: false };
  var configured = !!(info && (info.configured || info.loggedIn));
  var webSession = !!(info && info.webSession);
  var sessionExpired = !!(info && info.sessionExpired);
  var capabilities = info && info.capabilities || {};
  var searchReady = !!(configured || capabilities.search || info && info.publicCatalog);
  return Object.assign({}, fallback, info || {}, {
    provider: 'qishui',
    // 服务端确认会话失效（PC 接口 401/403）时按掉登录处理：否则前端会
    // 一直显示已登录、歌单同步却永远失败（见服务端 handleQishuiStatus）。
    loggedIn: sessionExpired ? false : configured,
    configured: configured,
    oauthConfigured: !!(info && (info.oauthConfigured || (info.oauth && info.oauth.configured))),
    oauthMissing: info && Array.isArray(info.oauthMissing) ? info.oauthMissing : [],
    userId: info && (info.userId || info.openId || info.open_id || info.tokenSource || info.scope || '') || '',
    nickname: info && info.nickname ? info.nickname : (webSession ? '汽水音乐账号' : (configured ? '汽水开放平台' : fallback.nickname)),
    avatar: info && info.avatar || '',
    vipType: Number(info && (info.vipType || info.vip_type) || 0) || 0,
    vipLevel: info && (info.vipLevel || info.vip_level) || 'none',
    isVip: !!(info && info.isVip),
    isSvip: !!(info && info.isSvip),
    playbackKeyReady: !!(!sessionExpired && webSession && capabilities.playableUrl),
    playbackMode: info && info.playbackMode || 'recommend-match',
    searchReady: searchReady,
    webSession: webSession,
    cookieReady: !!(!sessionExpired && info && info.cookieReady),
    tokenConfigured: !!(info && info.tokenConfigured),
    publicCatalog: !!(!configured && searchReady),
    stale: !!(info && (info.stale || sessionExpired)),
    sessionExpired: sessionExpired
  });
}
async function refreshQishuiLoginStatus() {
  try {
    var info = await apiJson('/api/qishui/status?t=' + Date.now());
    var prevLogged = !!qishuiLoginStatus.loggedIn;
    qishuiLoginStatus = normalizeQishuiLoginStatus(info);
    auditProviderVipState('qishui', qishuiLoginStatus);
    if (!qishuiLoginStatus.loggedIn) {
      if (qishuiLoginStatus.sessionExpired) {
        if (!qishuiSessionExpiredNotified) { qishuiSessionExpiredNotified = true; showToast('汽水音乐登录已失效，请重新登录'); }
      } else if (prevLogged || qishuiLoginWasLoggedIn) showToast('汽水音乐授权已清除');
      qishuiPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qishui'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if ((fx && fx.shelfMergeCollections) ? !qishuiPlaylists.length : !userPlaylists.some(function (pl) { return pl && pl.provider === 'qishui'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
    }
    if (qishuiLoginStatus.loggedIn) qishuiSessionExpiredNotified = false;
    qishuiLoginWasLoggedIn = !!qishuiLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return qishuiLoginStatus;
  } catch (e) {
    console.warn('Qishui login status failed:', e);
    qishuiLoginStatus = normalizeQishuiLoginStatus(null);
    renderUserBtn();
    return qishuiLoginStatus;
  }
}
function startQishuiLoginStatusAutoRefresh() {
  if (qishuiLoginAutoRefreshTimer) clearInterval(qishuiLoginAutoRefreshTimer);
  qishuiLoginAutoRefreshTimer = setInterval(function () {
    if (document.hidden) return; // 后台不轮询，可见时 focus/visibility 补刷
    refreshQishuiLoginStatus().catch(function (e) { console.warn('Qishui login auto refresh failed:', e); });
  }, 45000);
  if (startQishuiLoginStatusAutoRefresh._boundFocusRefresh) return;
  startQishuiLoginStatusAutoRefresh._boundFocusRefresh = true;
  function refreshQishuiOnVisible() {
    if (document.hidden) return;
    if (!qishuiLoginStatus.loggedIn && !qishuiLoginWasLoggedIn) return;
    refreshQishuiLoginStatus().catch(function (e) { console.warn('Qishui login foreground refresh failed:', e); });
  }
  window.addEventListener('focus', function () { refreshQishuiOnVisible(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshQishuiOnVisible(); });
}

function normalizeSpotifyLoginStatus(info) {
  var fallback = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', accountId: '', avatar: '', product: '', membershipKnown: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, reauthRequired: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false, searchReady: false };
  var loggedIn = !!(info && info.loggedIn);
  var product = String(info && info.product || '').toLowerCase();
  var isPremium = loggedIn && product === 'premium';
  var capabilities = info && info.capabilities || {};
  return Object.assign({}, fallback, info || {}, {
    provider: 'spotify',
    loggedIn: loggedIn,
    configured: !!(info && (info.configured || loggedIn)),
    oauthConfigured: !!(info && info.oauthConfigured),
    oauthMissing: info && Array.isArray(info.oauthMissing) ? info.oauthMissing : [],
    nickname: info && (info.nickname || info.displayName || info.display_name) || fallback.nickname,
    userId: info && (info.userId || info.id) || '',
    accountId: info && (info.accountId || info.account_id) || '',
    avatar: info && info.avatar || '',
    product: product,
    membershipKnown: !!(info && (info.membershipKnown || product)),
    vipType: isPremium ? 1 : 0,
    vipLevel: isPremium ? 'vip' : 'none',
    isVip: isPremium,
    isSvip: false,
    tokenConfigured: !!(info && info.tokenConfigured),
    tokenFileExists: !!(info && info.tokenFileExists),
    credentialsFileExists: !!(info && info.credentialsFileExists),
    localConfigMissing: !!(info && info.localConfigMissing),
    playbackKeyReady: loggedIn,
    playbackMode: 'recommend-match',
    searchReady: !!(capabilities.search || info && info.searchReady),
    stale: !!(info && info.stale),
    reauthRequired: !!(info && info.reauthRequired)
  });
}
async function refreshSpotifyLoginStatus() {
  try {
    var info = await apiJson('/api/spotify/status?t=' + Date.now());
    var prevLogged = !!spotifyLoginStatus.loggedIn;
    spotifyLoginStatus = normalizeSpotifyLoginStatus(info);
    auditProviderVipState('spotify', spotifyLoginStatus);
    if (!spotifyLoginStatus.loggedIn) {
      if (prevLogged || spotifyLoginWasLoggedIn) showToast(spotifyLoginStatus.stale ? 'Spotify 登录已失效' : 'Spotify 已退出');
      spotifyPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'spotify'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if ((fx && fx.shelfMergeCollections) ? !spotifyPlaylists.length : !userPlaylists.some(function (pl) { return pl && pl.provider === 'spotify'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
    }
    spotifyLoginWasLoggedIn = !!spotifyLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return spotifyLoginStatus;
  } catch (e) {
    console.warn('Spotify login status failed:', e);
    spotifyLoginStatus = normalizeSpotifyLoginStatus(null);
    renderUserBtn();
    return spotifyLoginStatus;
  }
}
function startSpotifyLoginStatusAutoRefresh() {
  if (spotifyLoginAutoRefreshTimer) clearInterval(spotifyLoginAutoRefreshTimer);
  spotifyLoginAutoRefreshTimer = setInterval(function () {
    if (document.hidden) return; // 后台不轮询，可见时 focus/visibility 补刷
    refreshSpotifyLoginStatus().catch(function (e) { console.warn('Spotify login auto refresh failed:', e); });
  }, 45000);
  if (startSpotifyLoginStatusAutoRefresh._boundFocusRefresh) return;
  startSpotifyLoginStatusAutoRefresh._boundFocusRefresh = true;
  function refreshSpotifyOnVisible() {
    if (document.hidden) return;
    if (!spotifyLoginStatus.loggedIn && !spotifyLoginWasLoggedIn) return;
    refreshSpotifyLoginStatus().catch(function (e) { console.warn('Spotify login foreground refresh failed:', e); });
  }
  window.addEventListener('focus', function () { refreshSpotifyOnVisible(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshSpotifyOnVisible(); });
}

function renderUserBtn() {
  var btn = document.getElementById('user-btn');
  if (!btn) return;
  var loggedIn = hasAnyPlatformLogin();
  var externalProviders = accountProviderExternalRenderList().filter(function (provider) {
    return hasPlatformLogin(provider);
  });
  if (loggedIn && !externalProviders.length) externalProviders = [firstLoggedProvider()];
  var topRight = document.getElementById('top-right');
  if (topRight) topRight.classList.toggle('account-pill-stack', externalProviders.length > 1);
  btn.classList.remove('multi-account', 'external-account-pills', 'login-eye-avatar', 'logged-in', 'logged-out');
  if (loggedIn) {
    activeAccountProvider = firstLoggedProvider();
    var st = platformStatus(activeAccountProvider);
    var meta = platformMeta(activeAccountProvider);
    btn.classList.add('logged-in', 'multi-account', 'external-account-pills');
    btn.title = providerAccountIdentity(activeAccountProvider, st) + ' / 账号与登录接入';
    btn.innerHTML = externalProviders.map(function (provider) {
      return renderTopAccountPill(provider);
    }).join('');
  } else {
    btn.classList.add('logged-out', 'login-eye-avatar');
    btn.title = '登录账号';
    btn.innerHTML = typeof loginEasterEggEyeMarkup === 'function'
      ? loginEasterEggEyeMarkup(true)
      : '<span class="login-word">登录</span>';
  }
  if (typeof updateAccountPillGlassDisplacementMap === 'function') {
    requestAnimationFrame(updateAccountPillGlassDisplacementMap);
  }
  bindTopAccountPillSorting();
  if (typeof updateLoginNodeGraphUi === 'function') {
    requestAnimationFrame(updateLoginNodeGraphUi);
  }
  updatePlaybackQualityUi();
}
