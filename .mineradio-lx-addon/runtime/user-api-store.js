'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const vm = require('node:vm');

const MAX_SOURCE_SIZE = 1024 * 1024;

// 分发型 URL 的末段通常是 "latest.js"/"index.js" 之类的通用名，不能作为歌源
// 显示名称；歌源脚本自身声明的名称（@name 头注释 / export default 的 name）
// 才是真正的名字。
const GENERIC_SOURCE_NAMES = new Set(['latest', 'index', 'main', 'master', 'release', 'download', 'script']);

function cleanSourceName(value) {
  const cleaned = String(value == null ? '' : value).replace(/[\s:*]+$/g, '').replace(/^[\s:*]+/g, '').trim();
  if (!cleaned || cleaned.length > 80) return '';
  return cleaned;
}

function detectSourceName(sourceText) {
  const text = String(sourceText || '');
  if (!text.trim()) return '';
  // 1) userscript 风格头注释：// @name 名称  或  /** @name 名称 */
  //    \b 防止误匹配 @namespace / @filename 等相邻头注释
  const head = text.slice(0, 2048);
  const header = /@name\b\s*[:：]?\s*([^\r\n*]+)/i.exec(head);
  if (header) {
    const value = cleanSourceName(header[1]);
    if (value) return value;
  }
  // 2) lx-music UserApi 导出对象：export default { name: '...' } /
  //    module.exports = { name: "..." }。在导出标记后 4KB 窗口内找第一个
  //    name 字符串字面量（动作列表很长时 name 也可能排在对象末尾）。
  const marker = /export\s+default|module\.exports/i.exec(text);
  if (marker) {
    const windowText = text.slice(marker.index, marker.index + 4096);
    const match = /\bname\s*:\s*(['"])([^'"]{1,80})\1/.exec(windowText);
    if (match) {
      const value = cleanSourceName(match[2]);
      if (value) return value;
    }
  }
  return '';
}

function resolveSourceName(metadata, sourceText) {
  const explicit = String((metadata && metadata.name) || '').trim();
  if (explicit) return explicit;
  return detectSourceName(sourceText);
}

function createUserApiStore(options = {}) {
  const records = new Map();
  let activeSourceId = null;
  let generation = 0;
  const file = options.filePath ? path.resolve(options.filePath) : null;
  let persistQueue = Promise.resolve();

  function restore() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      generation = Number.isFinite(Number(saved.generation)) ? Number(saved.generation) : 0;
      for (const item of Array.isArray(saved.sources) ? saved.sources : []) {
        if (!item || typeof item.sourceId !== 'string' || typeof item.sourceText !== 'string' || !item.sourceText.trim()) continue;
        const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : { sourceId: item.sourceId };
        records.set(item.sourceId, {
          sourceId: item.sourceId,
          sourceText: item.sourceText,
          metadata: { ...metadata, sourceId: item.sourceId },
          status: item.status === 'active' ? 'active' : 'imported',
          generation: Number(item.generation) || 0,
          createdAt: item.createdAt || new Date().toISOString()
        });
      }
      activeSourceId = records.has(saved.activeSourceId) ? saved.activeSourceId : null;
      if (activeSourceId) for (const record of records.values()) record.status = record.sourceId === activeSourceId ? 'active' : 'imported';
    } catch (_) {
      activeSourceId = null;
      generation = 0;
      records.clear();
    }
  }

  restore();

  function persist() {
    if (!file) return Promise.resolve();
    persistQueue = persistQueue.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const payload = [...records.values()].map(({ sourceText, ...metadata }) => ({ ...metadata, sourceText }));
      await fsp.writeFile(file, JSON.stringify({ activeSourceId, generation, sources: payload }, null, 2));
    });
    return persistQueue;
  }

  function addSource(sourceText, metadata = {}) {
    if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('source text is required');
    if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_SIZE) throw new Error('source text exceeds size limit');
    try {
      new vm.Script(sourceText, { filename: metadata.name || 'mineradio-lx-user-api.js' });
    } catch (error) {
      error.code = 'USER_API_SOURCE_SYNTAX';
      error.message = `UserApi source syntax error: ${error.message}`;
      throw error;
    }
    const sourceId = metadata.sourceId || crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
    const name = resolveSourceName(metadata, sourceText);
    const record = { sourceId, sourceText, metadata: { ...metadata, sourceId, ...(name ? { name } : {}) }, status: 'imported', generation: generation + 1, createdAt: new Date().toISOString() };
    records.set(sourceId, record);
    void persist();
    return { ...record, sourceText: undefined };
  }

  async function activateSource(sourceId) {
    const record = records.get(sourceId);
    if (!record) throw new Error(`unknown source: ${sourceId}`);
    activeSourceId = sourceId;
    generation += 1;
    record.status = 'active';
    record.generation = generation;
    for (const value of records.values()) if (value.sourceId !== sourceId && value.status === 'active') value.status = 'imported';
    await persist();
    return { sourceId, generation, sourceText: record.sourceText, metadata: record.metadata };
  }

  async function removeSource(sourceId) {
    const wasActive = activeSourceId === sourceId;
    records.delete(sourceId);
    if (wasActive) { activeSourceId = null; generation += 1; }
    await persist();
    return { sourceId, active: false, generation };
  }

  function getActiveSource() {
    const record = activeSourceId ? records.get(activeSourceId) : null;
    return record ? { ...record, sourceText: record.sourceText } : null;
  }

  function getSource(sourceId) {
    const record = records.get(String(sourceId || ''));
    return record ? { ...record, sourceText: record.sourceText } : null;
  }

  function displayMetadata(record) {
    const metadata = record.metadata || {};
    const storedName = String(metadata.name || '').trim();
    const generic = !storedName || GENERIC_SOURCE_NAMES.has(storedName.toLowerCase());
    if (!generic) return metadata;
    // 兼容已导入的历史数据：之前分发型 URL 会把所有歌源命名为 "latest"，
    // 这里用脚本自身声明的名称在显示层修正，无需重新导入。
    const detected = detectSourceName(record.sourceText);
    if (!detected) return metadata;
    return { ...metadata, name: detected };
  }

  function getState() {
    return {
      generation,
      activeSourceId,
      sources: [...records.values()].map(record => ({ sourceId: record.sourceId, metadata: displayMetadata(record), status: record.status, generation: record.generation }))
    };
  }

  function invalidateAll() {
    generation += 1;
    return generation;
  }

  return { addSource, activateSource, removeSource, getActiveSource, getSource, getState, invalidateAll };
}

const defaultStore = createUserApiStore();

module.exports = {
  createUserApiStore,
  detectSourceName,
  GENERIC_SOURCE_NAMES,
  addSource: defaultStore.addSource,
  activateSource: defaultStore.activateSource,
  removeSource: defaultStore.removeSource,
  getActiveSource: defaultStore.getActiveSource,
  getSource: defaultStore.getSource,
  getState: defaultStore.getState,
  invalidateAll: defaultStore.invalidateAll
};
