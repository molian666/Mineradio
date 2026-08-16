const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const mediaSessionPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '12-system-media-session.js');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const playerControlsPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js');
const coverDepthPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '15-ripples-cover-depth.js');
const mediaSessionSource = fs.readFileSync(mediaSessionPath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const playerControlsSource = fs.readFileSync(playerControlsPath, 'utf8');
const coverDepthSource = fs.readFileSync(coverDepthPath, 'utf8');

function createMediaSessionRecording() {
  const calls = {
    metadata: [],
    playbackState: [],
    position: [],
    actions: {}
  };
  let playbackState = 'none';
  const navigator = {
    mediaSession: {
      set metadata(v) { calls.metadata.push(v); },
      get metadata() { return calls.metadata[calls.metadata.length - 1] || null; },
      set playbackState(v) { playbackState = v; calls.playbackState.push(v); },
      get playbackState() { return playbackState; },
      setActionHandler(action, handler) {
        calls.actions[action] = handler;
      },
      setPositionState(state) {
        calls.position.push(Object.assign({}, state));
      }
    }
  };
  return { navigator, calls };
}

function createMediaSessionSandbox() {
  const rec = createMediaSessionRecording();
  const calls = rec.calls;
  const actions = [];
  const sandbox = {
    navigator: rec.navigator,
    document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
    MediaMetadata: function (meta) { return meta; },
    queueItemKey: (song) => song && song.name ? ('k:' + song.name) : '',
    currentCoverSong: () => ({
      name: '测试歌曲',
      artist: '测试歌手',
      album: '测试专辑',
      cover: 'https://example.com/cover.jpg'
    }),
    getPlaybackDurationSeconds: () => 200,
    getPlaybackCurrentSeconds: () => 42,
    playQueue: [],
    currentIdx: -1,
    playing: true,
    audio: null,
    songCoverSrc: () => 'https://example.com/cover.jpg',
    playbackDurationFromSong: () => 200,
    setInterval: () => 0,
    clearInterval: () => {},
    togglePlay() { actions.push('play'); },
    nextTrack() { actions.push('next'); },
    prevTrack() { actions.push('prev'); },
    fadeOutAndPauseAudio() { actions.push('pause'); },
    updatePlaybackProgressUi() {},
    Math,
    Number,
    String,
    Array,
    Object,
    Date,
    isFinite
  };
  vm.createContext(sandbox);
  vm.runInContext(mediaSessionSource, sandbox, { filename: '12-system-media-session.js' });
  return { sandbox, calls, actions };
}

test('SMTC module is loaded by the classic index loader', () => {
  assert.match(loaderSource, /'js\/modules\/00-state\/12-system-media-session\.js'/);
});

test('SMTC registers transport action handlers for play/pause/prev/next/seek', () => {
  const { calls } = createMediaSessionSandbox();
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop']) {
    assert.equal(typeof calls.actions[action], 'function', action + ' handler missing');
  }
});

test('SMTC pushes playing state, metadata and position on sync', () => {
  const { sandbox, calls } = createMediaSessionSandbox();
  sandbox.syncSystemMediaSessionNow('test');
  assert.ok(calls.playbackState.length >= 1);
  assert.equal(calls.playbackState[calls.playbackState.length - 1], 'playing');
  assert.ok(calls.metadata.length >= 1);
  assert.equal(calls.metadata[calls.metadata.length - 1].title, '测试歌曲');
  assert.equal(calls.metadata[calls.metadata.length - 1].artist, '测试歌手');
  assert.ok(calls.position.length >= 1);
  assert.equal(calls.position[0].duration, 200);
  assert.equal(calls.position[0].position, 42);
});

test('SMTC reflects paused state via setSystemMediaSessionPlaybackState', () => {
  const { sandbox, calls } = createMediaSessionSandbox();
  sandbox.setSystemMediaSessionPlaybackState(false);
  assert.equal(calls.playbackState[calls.playbackState.length - 1], 'paused');
});

test('SMTC next/prev actions route to playback controls', () => {
  const { calls, actions } = createMediaSessionSandbox();
  calls.actions.nexttrack();
  calls.actions.previoustrack();
  calls.actions.pause();
  assert.deepEqual(actions, ['next', 'prev', 'pause']);
});

test('setPlayIcon and updateControlTrackInfo feed the system media session', () => {
  assert.match(playerControlsSource, /function setPlayIcon\(p\)[\s\S]*setSystemMediaSessionPlaybackState\(!!p\)/);
  assert.match(coverDepthSource, /updateControlTrackInfo\(song\)[\s\S]*syncSystemMediaSessionNow\('track-info'\)/);
});

console.log('PASS tests/system-media-session.test.js');
