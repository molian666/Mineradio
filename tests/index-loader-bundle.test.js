const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const bundler = require('../scripts/bundle-index-modules.js');

test('C3 loader keeps an inlined modulePaths array for the bundler', () => {
  const match = loaderSource.match(/const modulePaths = \[([\s\S]*?)\];/);
  assert.ok(match, 'modulePaths array must be inlined in index-loader.js');
  const paths = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 100, 'expected 100+ modules');
});

test('C3 loader no longer uses blocking synchronous XHR', () => {
  assert.doesNotMatch(loaderSource, /\bopen\([^)]*false\s*\)/, 'loader must not block on sync XHR');
  assert.match(loaderSource, /request\.open\('GET',\s*path,\s*true\)/, 'XHR must open asynchronously');
});

test('C3 loader prefers the prebuilt bundle and falls back to parallel fetch', () => {
  assert.match(loaderSource, /function loadIndexModulesFromBundle\(\)/);
  assert.match(loaderSource, /function loadIndexModulesParallel\(\)/);
  assert.match(loaderSource, /loadIndexModulesFromBundle\(\)[\s\S]{0,120}\.catch\([\s\S]{0,120}loadIndexModulesParallel\(\)/);
  assert.match(loaderSource, /#MINERADIO_INDEX_BUNDLE/);
});

test('C3 progressive loading keeps module order via parallel-fetch concat', () => {
  assert.match(loaderSource, /modulePaths\.map\(function \(path\)[\s\S]{0,160}Promise\.all/);
  assert.match(loaderSource, /texts\.join\(''\)/);
});

test('C3 bundler produces parseable output matching the module list', () => {
  const out = bundler.buildBundleIndexModuleText();
  assert.equal(out.moduleCount, bundler.readModulePaths(loaderSource).length);
  new Function(out.text); // must parse
  assert.match(out.text, /#MINERADIO_INDEX_BUNDLE/);
  // each module file should appear in the bundle text
  const match = loaderSource.match(/const modulePaths = \[([\s\S]*?)\];/);
  const paths = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const p of paths.slice(0, 3)) {
    const src = fs.readFileSync(path.join(appRoot, 'public', p), 'utf8');
    assert.ok(src.length > 20, 'module source should be non-trivial');
  }
});

test('C3 package scripts wire the bundle step into builds', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['bundle:index'], 'node scripts/bundle-index-modules.js');
  assert.match(pkg.scripts['build:win'], /bundle:index/);
  assert.match(pkg.scripts['build:win:dir'], /bundle:index/);
});

test('C3 generated bundle is gitignored as a build artifact', () => {
  const gitignore = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /public\/js\/index-bundle\.js/);
});

console.log('PASS tests/index-loader-bundle.test.js');
