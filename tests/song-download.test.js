const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test, afterEach } = require('node:test');

let downloadModule;
try {
  downloadModule = require('../desktop/song-download');
} catch (_) {
  downloadModule = {};
}

const testRoots = [];

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDownloadTestEnv(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mineradio-song-download-'));
  testRoots.push(root);
  const settingsFile = path.join(root, 'download-settings.json');
  const downloadDirectory = path.join(root, 'songs');
  await fs.mkdir(downloadDirectory, { recursive: true });
  if (options.savedDirectory) {
    await fs.writeFile(settingsFile, JSON.stringify({ version: 1, downloadPath: options.savedDirectory }), 'utf8');
  }
  let dialogCalls = 0;
  let fetchCalls = 0;
  const dialog = {
    async showOpenDialog() {
      dialogCalls += 1;
      return options.canceled
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [options.chosenDirectory || downloadDirectory] };
    },
  };
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (options.responseError) throw options.responseError;
    const body = Readable.toWeb(Readable.from([Buffer.from('audio-data')]));
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? (options.contentType || 'audio/mpeg') : null },
      body,
    };
  };
  assert.equal(typeof downloadModule.createSongDownloadService, 'function', 'download service must be exported');
  const service = downloadModule.createSongDownloadService({ settingsFile, dialog, fetchImpl });
  return {
    root,
    settingsFile,
    downloadDirectory,
    service,
    get dialogCalls() { return dialogCalls; },
    get fetchCalls() { return fetchCalls; },
  };
}

test('first download chooses and persists a directory', async () => {
  const env = await makeDownloadTestEnv();
  const result = await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  assert.equal(result.ok, true);
  assert.equal(env.dialogCalls, 1);
  assert.equal(JSON.parse(await fs.readFile(env.settingsFile, 'utf8')).downloadPath, env.downloadDirectory);
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'audio-data');
});

test('saved directory is reused without opening the picker', async () => {
  const env = await makeDownloadTestEnv({ savedDirectory: '' });
  await fs.writeFile(env.settingsFile, JSON.stringify({ version: 1, downloadPath: env.downloadDirectory }), 'utf8');
  const result = await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  assert.equal(result.ok, true);
  assert.equal(env.dialogCalls, 0);
});

test('canceling directory selection does not download or persist a path', async () => {
  const env = await makeDownloadTestEnv({ canceled: true });
  const result = await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  assert.deepEqual(result, { ok: false, canceled: true, error: 'DOWNLOAD_DIRECTORY_NOT_SELECTED' });
  assert.equal(env.fetchCalls, 0);
  assert.equal(await fs.stat(env.settingsFile).catch(() => null), null);
});

test('duplicate filenames receive a numeric suffix', async () => {
  const env = await makeDownloadTestEnv({ savedDirectory: '' });
  await fs.writeFile(env.settingsFile, JSON.stringify({ version: 1, downloadPath: env.downloadDirectory }), 'utf8');
  await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  const second = await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  assert.equal(second.ok, true);
  assert.equal(second.filename, 'A - One (2).mp3');
});

test('failed stream removes the temporary file', async () => {
  const env = await makeDownloadTestEnv({ savedDirectory: '', responseError: new Error('network') });
  await fs.writeFile(env.settingsFile, JSON.stringify({ version: 1, downloadPath: env.downloadDirectory }), 'utf8');
  const result = await env.service.download({ url: 'https://audio.test/a.mp3', artist: 'A', title: 'One' });
  assert.equal(result.ok, false);
  assert.deepEqual((await fs.readdir(env.downloadDirectory)).filter((name) => name.includes('.downloading')), []);
});

test('filename sanitization protects Windows-invalid and reserved names', () => {
  assert.equal(typeof downloadModule.sanitizeDownloadStem, 'function');
  const stem = downloadModule.sanitizeDownloadStem('Artist:/Name', 'CON.');
  assert.doesNotMatch(stem, /[\\/:*?"<>|]/);
  assert.doesNotMatch(stem, /[. ]$/);
  assert.notEqual(stem.toUpperCase(), 'CON');
});

test('audio extension follows content type and URL fallback', () => {
  assert.equal(downloadModule.inferAudioExtension('audio/flac', 'https://audio.test/a.mp3'), '.flac');
  assert.equal(downloadModule.inferAudioExtension('', 'https://audio.test/a.m4a'), '.m4a');
  assert.equal(downloadModule.inferAudioExtension('', 'https://audio.test/no-extension'), '.mp3');
});

test('only HTTP(S) source URLs are accepted', async () => {
  const env = await makeDownloadTestEnv({ savedDirectory: '' });
  await fs.writeFile(env.settingsFile, JSON.stringify({ version: 1, downloadPath: env.downloadDirectory }), 'utf8');
  const result = await env.service.download({ url: 'file:///tmp/a.mp3', artist: 'A', title: 'One' });
  assert.equal(result.ok, false);
  assert.equal(env.fetchCalls, 0);
});

test('changing the directory persists without moving existing files', async () => {
  const env = await makeDownloadTestEnv({ savedDirectory: '' });
  const originalDirectory = path.join(env.root, 'original');
  const nextDirectory = path.join(env.root, 'next');
  await fs.mkdir(originalDirectory, { recursive: true });
  await fs.mkdir(nextDirectory, { recursive: true });
  const existing = path.join(originalDirectory, 'existing.mp3');
  await fs.writeFile(existing, 'keep', 'utf8');
  await env.service.setDirectory(originalDirectory);
  await env.service.setDirectory(nextDirectory);
  assert.equal(JSON.parse(await fs.readFile(env.settingsFile, 'utf8')).downloadPath, nextDirectory);
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
});
