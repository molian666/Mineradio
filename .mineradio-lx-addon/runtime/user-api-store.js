'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const vm = require('node:vm');

const MAX_SOURCE_SIZE = 1024 * 1024;

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
    const record = { sourceId, sourceText, metadata: { ...metadata, sourceId }, status: 'imported', generation: generation + 1, createdAt: new Date().toISOString() };
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

  function getState() {
    return {
      generation,
      activeSourceId,
      sources: [...records.values()].map(record => ({ sourceId: record.sourceId, metadata: record.metadata, status: record.status, generation: record.generation }))
    };
  }

  function invalidateAll() {
    generation += 1;
    return generation;
  }

  return { addSource, activateSource, removeSource, getActiveSource, getState, invalidateAll };
}

const defaultStore = createUserApiStore();

module.exports = {
  createUserApiStore,
  addSource: defaultStore.addSource,
  activateSource: defaultStore.activateSource,
  removeSource: defaultStore.removeSource,
  getActiveSource: defaultStore.getActiveSource,
  getState: defaultStore.getState,
  invalidateAll: defaultStore.invalidateAll
};
