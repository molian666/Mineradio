'use strict';
// 合并歌单默认状态回归测试
// 覆盖：设置恢复时 shelfMergeCollections 缺字段（旧版本存档 / 首次使用）必须
// 默认开启，与 fxDefaults.shelfMergeCollections = true 一致；否则用户从未主动
// 关闭过也会出现"合并歌单不显示"。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', 'public');

test('合并歌单设置恢复：存档缺字段时默认开启（!== false 而非 === true）', () => {
  const persistence = fs.readFileSync(path.join(ROOT, 'js/modules/02-visual/04-visual-settings-persistence.js'), 'utf8');
  const preset = fs.readFileSync(path.join(ROOT, 'js/modules/07-fx/00-preset-archive-data.js'), 'utf8');
  // 用户设置恢复与视觉预设恢复都必须用 !== false：raw 缺字段（undefined）时
  // 保持默认开启；=== true 会让 undefined 变 false，导致合并歌单被静默关闭。
  assert.match(persistence, /shelfMergeCollections:\s*raw\.shelfMergeCollections\s*!==\s*false/);
  assert.match(preset, /shelfMergeCollections:\s*raw\.shelfMergeCollections\s*!==\s*false/);
});

test('fxDefaults 中合并歌单默认开启（与恢复逻辑一致）', () => {
  const defaults = fs.readFileSync(path.join(ROOT, 'js/modules/00-state/04-fx-defaults.js'), 'utf8');
  assert.match(defaults, /shelfMergeCollections:\s*true/);
});

test('播放列表面板分组必须包含 merged（否则合并歌单卡永不渲染）', () => {
  const detail = fs.readFileSync(path.join(ROOT, 'js/modules/06-lyrics/02-playlist-detail.js'), 'utf8');
  // playlistPanelBuildVirtualEntries 按 order 遍历分组；开启合并歌单时
  // userPlaylists 只含 merged 记录，order 缺 merged 会导致列表为空
  assert.match(detail, /var order = \['merged', 'netease', 'qq', 'kugou', 'qishui', 'spotify'\]/);
  assert.match(detail, /labels\[key\]\s*\|\|\s*key/);
});

