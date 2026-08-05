const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DOWNLOAD_SETTINGS_VERSION = 1;
const AUDIO_EXTENSION_BY_TYPE = new Map([
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac'],
  ['audio/mp4', '.m4a'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['video/mp4', '.m4a'],
]);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm']);

function normalizeDownloadSettings(value) {
  const candidate = String(value && value.downloadPath || '').trim();
  let downloadPath = '';
  if (candidate) {
    try {
      downloadPath = path.resolve(candidate);
    } catch (_) {}
  }
  return { version: DOWNLOAD_SETTINGS_VERSION, downloadPath };
}

function sanitizeDownloadPart(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
}

function sanitizeDownloadStem(artist, title) {
  const parts = [sanitizeDownloadPart(artist), sanitizeDownloadPart(title)].filter(Boolean);
  let stem = parts.join(' - ') || 'Mineradio Song';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}_`;
  return stem.slice(0, 180).replace(/[. ]+$/g, '') || 'Mineradio Song';
}

function inferAudioExtension(contentType, sourceUrl) {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (AUDIO_EXTENSION_BY_TYPE.has(mime)) return AUDIO_EXTENSION_BY_TYPE.get(mime);
  try {
    const extension = path.extname(new URL(String(sourceUrl || '')).pathname).toLowerCase();
    if (AUDIO_EXTENSIONS.has(extension)) return extension;
  } catch (_) {}
  return '.mp3';
}

function sourceUrlIsHttp(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function nextAvailablePath(directory, stem, extension) {
  let index = 1;
  while (true) {
    const suffix = index === 1 ? '' : ` (${index})`;
    const candidate = path.join(directory, `${stem}${suffix}${extension}`);
    if (!(await pathExists(candidate))) return candidate;
    index += 1;
  }
}

function responseStream(response) {
  if (response && response.body && typeof response.body.getReader === 'function') {
    return Readable.fromWeb(response.body);
  }
  return response && response.body;
}

function downloadError(error, fallbackCode) {
  return {
    ok: false,
    code: error && error.code || fallbackCode,
    error: error && error.message || fallbackCode,
  };
}

function createSongDownloadService(options = {}) {
  const settingsFile = path.resolve(String(options.settingsFile || path.join(process.cwd(), 'download-settings.json')));
  const dialog = options.dialog || { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  async function readSettings() {
    try {
      const value = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
      return normalizeDownloadSettings(value);
    } catch (_) {
      return normalizeDownloadSettings(null);
    }
  }

  async function writeSettings(value) {
    const settings = normalizeDownloadSettings(value);
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
    const tempFile = `${settingsFile}.tmp-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(tempFile, JSON.stringify(settings, null, 2), 'utf8');
      await fsp.rename(tempFile, settingsFile);
    } catch (error) {
      await fsp.unlink(tempFile).catch(() => {});
      throw error;
    }
    return settings;
  }

  async function getSettings() {
    return { ok: true, settings: await readSettings() };
  }

  async function setDirectory(directory) {
    const settings = normalizeDownloadSettings({ downloadPath: directory });
    if (!settings.downloadPath) return { ok: false, error: 'DOWNLOAD_DIRECTORY_INVALID', code: 'DOWNLOAD_DIRECTORY_INVALID' };
    try {
      await fsp.mkdir(settings.downloadPath, { recursive: true });
      await fsp.access(settings.downloadPath, fs.constants.W_OK);
      await writeSettings(settings);
      return { ok: true, canceled: false, settings };
    } catch (error) {
      return downloadError(error, 'DOWNLOAD_DIRECTORY_UNAVAILABLE');
    }
  }

  async function chooseDirectory() {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, canceled: true, error: 'DOWNLOAD_DIRECTORY_NOT_SELECTED' };
    }
    return setDirectory(result.filePaths[0]);
  }

  async function download(payload = {}) {
    const url = String(payload.url || '').trim();
    if (!sourceUrlIsHttp(url)) return downloadError(null, 'DOWNLOAD_INVALID_URL');
    if (typeof fetchImpl !== 'function') return downloadError(null, 'DOWNLOAD_FETCH_UNAVAILABLE');

    let settings = await readSettings();
    if (!settings.downloadPath) {
      const selected = await chooseDirectory();
      if (!selected.ok) return selected;
      settings = selected.settings;
    } else {
      try {
        await fsp.mkdir(settings.downloadPath, { recursive: true });
        await fsp.access(settings.downloadPath, fs.constants.W_OK);
      } catch (error) {
        return downloadError(error, 'DOWNLOAD_DIRECTORY_UNAVAILABLE');
      }
    }

    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      return downloadError(error, 'DOWNLOAD_NETWORK_FAILED');
    }
    if (!response || !response.ok) {
      return downloadError(Object.assign(new Error(`DOWNLOAD_HTTP_${response && response.status || 0}`), {
        code: 'DOWNLOAD_HTTP_FAILED',
      }), 'DOWNLOAD_HTTP_FAILED');
    }
    const stream = responseStream(response);
    if (!stream) return downloadError(null, 'DOWNLOAD_BODY_UNAVAILABLE');

    const contentType = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type')
      : '';
    const extension = inferAudioExtension(contentType, url);
    const stem = sanitizeDownloadStem(payload.artist, payload.title);
    const finalPath = await nextAvailablePath(settings.downloadPath, stem, extension);
    const temporaryPath = `${finalPath}.downloading-${crypto.randomUUID()}`;
    try {
      await pipeline(stream, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
      await fsp.rename(temporaryPath, finalPath);
      return { ok: true, filePath: finalPath, filename: path.basename(finalPath) };
    } catch (error) {
      await fsp.unlink(temporaryPath).catch(() => {});
      return downloadError(error, 'DOWNLOAD_WRITE_FAILED');
    }
  }

  return { getSettings, setDirectory, chooseDirectory, download };
}

module.exports = {
  createSongDownloadService,
  inferAudioExtension,
  normalizeDownloadSettings,
  sanitizeDownloadStem,
  sourceUrlIsHttp,
};
