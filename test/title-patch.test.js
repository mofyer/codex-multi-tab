'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { patchExtension, transformHost, transformWebview, updatePanelTitle, observeTitle, waitForOnboardingState } = require('../src/compatibility/title-patch');
const { getNativePatchFiles, getNativeDependencies } = require('../src/compatibility/native-history-patch');

test('旧补丁入口与源码入口共享 API，CLI 默认备份保留在扩展根目录', t => {
  assert.equal(require('../title-patch'), require('../src/compatibility/title-patch'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multi-tab-layout-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'helper');
  fs.mkdirSync(root);
  fs.cpSync(path.join(__dirname, '../src/compatibility'), path.join(root, 'src/compatibility'), { recursive: true });
  for (const file of ['package.json', 'title-patch.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  const official = path.join(temporary, 'unsupported-official');
  fs.mkdirSync(official);
  fs.writeFileSync(path.join(official, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  let previous;
  for (const entry of ['title-patch.js', 'src/compatibility/title-patch.js']) {
    const usage = spawnSync(process.execPath, [path.join(root, entry)], { cwd: temporary, encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /用法：node title-patch.js/);
    const result = spawnSync(process.execPath, [path.join(root, entry), 'apply', official], { cwd: temporary, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不支持此官方扩展，拒绝修改/);
    if (previous) assert.equal(result.stderr, previous.stderr);
    previous = result;
    assert.deepEqual(fs.readdirSync(path.join(root, 'backups')), []);
    assert.equal(fs.existsSync(path.join(root, 'src/compatibility/backups')), false);
    assert.equal(fs.existsSync(path.join(temporary, 'backups')), false);
    fs.rmdirSync(path.join(root, 'backups'));
  }
});

const versions = {
  '26.5908.31748': 'app-initial-972655adec02.js',
  '26.908.40401': 'app-initial-a190b16fc630.js',
};

const nuxFixture = 'function lQn(){let{data:e,isLoading:t}=$g(xr.NUX_2025_09_15),{authMethod:n}=fu();if(!t){if(e)return`none`;switch(n){case`chatgpt`:return`2025-09-15-full-chatgpt-auth`;case`apikey`:return`2025-09-15-apikey-auth`;case null:return`none`}}}';

// 执行变换前后的函数，复现 pending + idle 误进引导，而非只断言补丁文本存在。
function verifyOnboardingGate(original, patched, name, queryHook, authHook) {
  let state, authMethod = 'chatgpt';
  const browser = browserFixture();
  const context = { document: browser.doc, URLSearchParams, xr: { NUX_2025_09_15: 'nux' },
    [queryHook]() { return state; }, [authHook]() { return { authMethod }; } };
  const before = vm.runInNewContext(`${original};${name}`, context);
  const after = vm.runInNewContext(`${patched};${name}`, context);
  state = { status: 'pending', fetchStatus: 'idle', isLoading: false, data: false };
  assert.equal(before(), '2025-09-15-full-chatgpt-auth');
  assert.equal(after(), undefined);
  state = { status: 'pending', fetchStatus: 'fetching', isLoading: true, data: false };
  assert.equal(after(), undefined);
  state = { status: 'success', fetchStatus: 'idle', isLoading: false, data: true };
  assert.equal(after(), 'none');
  state.data = false;
  assert.equal(after(), '2025-09-15-full-chatgpt-auth');
  authMethod = 'apikey';
  assert.equal(after(), '2025-09-15-apikey-auth');
  const failure = new Error('读取引导状态失败');
  state = { status: 'error', fetchStatus: 'idle', isLoading: false, data: false, error: failure };
  assert.throws(after, error => error === failure);
  for (const route of [null, '/local/a', '/extension/panel/new', '/extension/panel/new?codexMultiTab=']) {
    context.document = browserFixture(route).doc;
    assert.equal(after(), before());
    state = { status: 'pending', fetchStatus: 'idle', isLoading: false, data: false };
    assert.equal(after(), before());
    state = { status: 'error', fetchStatus: 'idle', isLoading: false, data: false, error: failure };
  }
}

test('宿主补丁从消息 sender 定位，保持标签隔离并排除侧栏与非辅助标签', () => {
  const a = { title: 'Codex' }, b = { title: 'Codex' }, regular = { title: '原标签' };
  const host = {
    editorPanels: new Map([
      [a, { initialRoute: '/extension/panel/new?codexMultiTab=a' }],
      [b, { initialRoute: '/extension/panel/new?codexMultiTab=b' }],
      [regular, { initialRoute: '/local/c' }],
    ]),
    findPanelByWebview(view) { return { a, b, regular }[view]; },
  };
  const source = transformHost('({async handleMessage(e,r){switch(r.type){case"navigate-in-new-editor-tab":{let n=pI(r.path);break;}}}})');
  const handler = vm.runInNewContext(source, { URLSearchParams }).handleMessage;
  handler.call(host, 'a', { type: 'codex-multi-tab-title', title: '  会话甲 🚀  ' });
  handler.call(host, 'b', { type: 'codex-multi-tab-title', title: '会话乙' });
  handler.call(host, 'sidebar', { type: 'codex-multi-tab-title', title: '不应显示' });
  handler.call(host, 'regular', { type: 'codex-multi-tab-title', title: '不应显示' });
  assert.equal(a.title, '会话甲 🚀');
  assert.equal(b.title, '会话乙');
  assert.equal(regular.title, '原标签');
  updatePanelTitle(host, 'a', undefined);
  assert.equal(a.title, '会话甲 🚀');
  updatePanelTitle(host, 'a', ' ');
  assert.equal(a.title, 'Codex');
  updatePanelTitle(host, 'a', 'ChatGPT');
  assert.equal(a.title, 'Codex');
  updatePanelTitle(host, 'a', '🚀'.repeat(121));
  assert.equal(Array.from(a.title).length, 120);
});

function browserFixture(route = '/extension/panel/new?codexMultiTab=a') {
  let mutation, cleanup, nextId = 0, disconnected = false;
  const scheduled = new Map(), messages = [];
  const doc = { title: 'ChatGPT', head: {}, querySelector() { return route ? { content: route } : null; } };
  const win = {
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe(target, options) { assert.equal(target, doc.head); assert.equal(options.characterData, true); }
      disconnect() { disconnected = true; }
    },
    setTimeout(callback, delay) { assert.equal(delay, 100); scheduled.set(++nextId, callback); return nextId; },
    clearTimeout(id) { scheduled.delete(id); },
    addEventListener(event, callback) { assert.equal(event, 'pagehide'); cleanup = callback; },
  };
  return { doc, win, messages, scheduled, api: { postMessage(message) { messages.push(message); } },
    mutate() { mutation(); }, flush() { for (const [id, cb] of scheduled) { scheduled.delete(id); cb(); } },
    close() { cleanup(); }, disconnected() { return disconnected; } };
}

test('webview 补丁只获取一次 API，初始发送并对标题变化节流去重', () => {
  const browser = browserFixture();
  let acquisitions = 0;
  const source = transformWebview(`let qf;function initialize(){qf=acquireVsCodeApi()}initialize();${nuxFixture}`, 'qf');
  vm.runInNewContext(source, { document: browser.doc, window: browser.win, URLSearchParams,
    acquireVsCodeApi() { acquisitions++; return browser.api; } });
  assert.equal(acquisitions, 1);
  assert.equal(browser.messages[0].title, 'Codex');
  browser.doc.title = '中文会话 🚀';
  browser.mutate(); browser.mutate();
  assert.equal(browser.scheduled.size, 1);
  browser.flush();
  assert.equal(browser.messages[1].title, '中文会话 🚀');
  browser.mutate(); browser.flush();
  assert.equal(browser.messages.length, 2);
  browser.doc.title = '改名后'; browser.mutate(); browser.flush();
  assert.equal(browser.messages[2].title, '改名后');
  browser.mutate(); browser.close();
  assert.equal(browser.disconnected(), true);
  assert.equal(browser.scheduled.size, 0);
});

test('普通面板和侧栏不监听标题', () => {
  for (const route of [null, '/local/a', '/extension/panel/new?other=codexMultiTab']) {
    const browser = browserFixture(route);
    observeTitle(browser.api, browser.doc, browser.win);
    assert.equal(browser.messages.length, 0);
  }
});

test('缺失或重复结构拒绝变换', () => {
  assert.throws(() => transformHost('unrecognized'), /特征/);
  assert.throws(() => transformHost('case"navigate-in-new-editor-tab":{let n=pI(r.path);'.repeat(2)), /特征/);
  assert.throws(() => transformWebview('x=acquireVsCodeApi()', 'qf'), /特征/);
  assert.throws(() => transformWebview('qf=acquireVsCodeApi()', 'qf'), /特征/);
  assert.throws(() => transformWebview(`qf=acquireVsCodeApi();${nuxFixture.repeat(2)}`, 'qf'), /特征/);
});

test('辅助标签等待读取引导状态，保留首次引导和错误；普通标签保持原行为', () => {
  const transformed = transformWebview(`qf=acquireVsCodeApi();${nuxFixture}`, 'qf');
  verifyOnboardingGate(nuxFixture, transformed.slice(transformed.indexOf('function lQn()')), 'lQn', '$g', 'fu');
  const document = browserFixture().doc;
  assert.equal(waitForOnboardingState('success', null, document), false);
  assert.equal(waitForOnboardingState('pending', null, document), true);
});

for (const [version, asset] of Object.entries(versions)) {
  const installed = path.join(os.homedir(), `.vscode/extensions/openai.chatgpt-${version}-darwin-arm64`);
  test(`真实 ${version} 副本：dry-run、apply 幂等、修改保护、restore 字节恢复`, { skip: !fs.existsSync(installed) }, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'extension'), backups = path.join(temporary, 'backups');
    const nativePatches = getNativePatchFiles(version);
    const additionalPatches = nativePatches.filter(patch => !['out/extension.js', `webview/assets/${asset}`].includes(patch.file));
    const dependencies = getNativeDependencies(version);
    const files = ['package.json', 'out/extension.js', `webview/assets/${asset}`, ...additionalPatches.map(patch => patch.file), ...dependencies.map(item => item.file)];
    const originals = new Map();
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      // 本机已应用补丁时使用经过哈希核对的原件备份，仍只测试临时副本。
      const rootHash = crypto.createHash('sha256').update(fs.realpathSync(installed)).digest('hex').slice(0, 16);
      const backupName = `${version}-${rootHash}`;
      const backup = [
        process.env.CODEX_MULTI_TAB_TEST_BACKUP_ROOT && path.join(process.env.CODEX_MULTI_TAB_TEST_BACKUP_ROOT, backupName),
        path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups', backupName),
        path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/yafan-local.codex-multi-tab/patch-backups', backupName),
        path.join(__dirname, '..', 'backups', backupName),
      ].filter(Boolean).find(directory => fs.existsSync(path.join(directory, 'manifest.json')))
        || path.join(__dirname, '..', 'backups', backupName);
      const manifestFile = path.join(backup, 'manifest.json');
      let bytes = fs.readFileSync(path.join(installed, file));
      // VS Code 清理过全量补丁备份时，从发行 VSIX 缓存取原字节，随后仍由补丁哈希硬门验证。
      const cachedVsix = path.join(os.homedir(), 'Library/Application Support/Code/CachedExtensionVSIXs', `openai.chatgpt-${version}-darwin-arm64`);
      if (file !== 'package.json' && fs.existsSync(cachedVsix)) {
        const original = spawnSync('unzip', ['-p', cachedVsix, `extension/${file}`], { maxBuffer: 30 * 1024 * 1024 });
        assert.equal(original.status, 0, original.stderr?.toString());
        bytes = original.stdout;
      }
      if (file !== 'package.json' && fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        assert.equal(manifest.root, fs.realpathSync(installed));
        const entry = manifest.files.find(item => item.file === file);
        // 旧备份只有两个文件，新增原生资产仍从未修改的安装目录取。
        if (entry) {
          bytes = fs.readFileSync(path.join(backup, entry.backup));
          assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.originalHash);
        }
      }
      originals.set(file, bytes);
      fs.writeFileSync(path.join(root, file), bytes);
    }
    assert.equal(patchExtension(root, 'dry-run', backups).status, 'ready');
    assert.equal(fs.existsSync(backups), false);
    fs.mkdirSync(backups);
    const rootIdentity = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
    const lock = path.join(backups, `.patch-${rootIdentity}.lock`);
    fs.writeFileSync(lock, 'another process');
    for (const action of ['apply', 'restore']) {
      assert.throws(() => patchExtension(root, action, backups), error => error.code === 'CODEX_MULTI_TAB_PATCH_BUSY');
    }
    assert.equal(fs.readFileSync(lock, 'utf8'), 'another process');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    fs.unlinkSync(lock);
    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = function (file, ...args) {
        if (String(file).endsWith('1.original')) throw new Error('模拟备份写入失败');
        return originalWrite.call(this, file, ...args);
      };
      assert.throws(() => patchExtension(root, 'apply', backups), /模拟备份写入失败/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.deepEqual(fs.readdirSync(backups), []);
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = function (from, to) {
        if (String(to).endsWith(additionalPatches.at(-1).file)) throw new Error('模拟最后文件写入失败');
        return originalRename.call(this, from, to);
      };
      assert.throws(() => patchExtension(root, 'apply', backups), /已撤销本次修改/);
    } finally { fs.renameSync = originalRename; }
    assert.deepEqual(fs.readdirSync(backups), []);
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    assert.equal(patchExtension(root, 'apply', backups).status, 'applied');
    assert.equal(patchExtension(root, 'apply', backups).status, 'already-applied');
    const api = version === '26.5908.31748' ? 'qf' : 'Jf';
    const name = version === '26.5908.31748' ? 'lQn' : 'pQn';
    const originalWebview = originals.get(`webview/assets/${asset}`).toString();
    const patchedWebview = fs.readFileSync(path.join(root, `webview/assets/${asset}`), 'utf8');
    // 真实 bundle 的函数边界由相邻 var 声明限定，两版本都运行原函数和实际变换后的函数。
    const extractNux = source => source.slice(source.indexOf(`function ${name}()`), source.indexOf('var ', source.indexOf(`function ${name}()`)));
    verifyOnboardingGate(extractNux(originalWebview), extractNux(patchedWebview), name,
      api === 'qf' ? '$g' : 'n_', api === 'qf' ? 'fu' : 'pu');
    const host = path.join(root, 'out/extension.js');
    const patched = fs.readFileSync(host);
    assert.notDeepEqual(patched, originals.get('out/extension.js'));
    new vm.Script(patched.toString());
    const webSyntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: fs.readFileSync(path.join(root, `webview/assets/${asset}`)), encoding: 'utf8' });
    assert.equal(webSyntax.status, 0, webSyntax.stderr);
    for (const patch of nativePatches) {
      const bytes = fs.readFileSync(path.join(root, patch.file));
      assert.notDeepEqual(bytes, originals.get(patch.file));
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: bytes, encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    fs.appendFileSync(host, '\n// other edit');
    assert.throws(() => patchExtension(root, 'restore', backups), /拒绝覆盖/);
    assert.equal(fs.readFileSync(host, 'utf8').endsWith('// other edit'), true);
    fs.writeFileSync(host, patched);
    // 原四文件增强升级为侧栏桥：旧清单仍可恢复，不能误报新版已应用。
    const oldFourDirectory = path.join(backups, fs.readdirSync(backups)[0]);
    const oldFourManifestPath = path.join(oldFourDirectory, 'manifest.json');
    const oldFourManifest = JSON.parse(fs.readFileSync(oldFourManifestPath, 'utf8'));
    for (const patch of nativePatches) {
      let source = originals.get(patch.file).toString();
      if (patch.file === 'out/extension.js') source = transformHost(source);
      if (patch.file === `webview/assets/${asset}`) source = transformWebview(source, api);
      const oldBytes = Buffer.from(patch.transform(source));
      fs.writeFileSync(path.join(root, patch.file), oldBytes);
      oldFourManifest.files.find(entry => entry.file === patch.file).patchedHash = crypto.createHash('sha256').update(oldBytes).digest('hex');
    }
    fs.writeFileSync(oldFourManifestPath, JSON.stringify(oldFourManifest));
    assert.throws(() => patchExtension(root, 'dry-run', backups), error => error.code === 'CODEX_MULTI_TAB_REAPPLY_REQUIRED');
    assert.throws(() => patchExtension(root, 'apply', backups), error => error.code === 'CODEX_MULTI_TAB_REAPPLY_REQUIRED');
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    assert.equal(patchExtension(root, 'apply', backups).status, 'applied');
    // 模拟旧标题补丁与其真实清单：新版必须拒绝假报已应用，仍允许恢复旧原件。
    const backupDirectory = path.join(backups, fs.readdirSync(backups)[0]);
    const manifestPath = path.join(backupDirectory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.patchVersion, require('../package.json').version);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, patchVersion: '99.0.0' }));
    for (const action of ['dry-run', 'apply', 'restore']) {
      assert.throws(() => patchExtension(root, action, backups), error => error.code === 'CODEX_MULTI_TAB_NEWER_PATCH_PRESENT');
      assert.deepEqual(fs.readFileSync(host), patched);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const patch of additionalPatches) fs.writeFileSync(path.join(root, patch.file), originals.get(patch.file));
    manifest.files = manifest.files.slice(0, 2);
    const oldHost = originals.get('out/extension.js').toString().replace('case"navigate-in-new-editor-tab":{let n=pI(r.path);',
      () => `case"codex-multi-tab-title":{(${updatePanelTitle.toString()})(this,e,r.title);break;}case"navigate-in-new-editor-tab":{let n=pI(r.path);`);
    fs.writeFileSync(host, oldHost);
    manifest.files[0].patchedHash = crypto.createHash('sha256').update(oldHost).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const candidate of [additionalPatches[0], dependencies[0]]) {
      const file = path.join(root, candidate.file);
      fs.appendFileSync(file, '\n// 其他来源的变更');
      assert.throws(() => patchExtension(root, 'dry-run', backups), error => error.code !== 'CODEX_MULTI_TAB_REAPPLY_REQUIRED' && /不兼容/.test(error.message));
      assert.equal(fs.readFileSync(host, 'utf8'), oldHost);
      fs.writeFileSync(file, originals.get(candidate.file));
    }
    assert.throws(() => patchExtension(root, 'dry-run', backups), /旧版本补丁.*restore/);
    assert.throws(() => patchExtension(root, 'apply', backups), /旧版本补丁.*restore/);
    const titleAnchor = `${api}=acquireVsCodeApi()`;
    const oldWebview = originalWebview.replace(titleAnchor, () => `${titleAnchor};(${observeTitle.toString()})(${api})`);
    fs.writeFileSync(path.join(root, `webview/assets/${asset}`), oldWebview);
    manifest.files[1].patchedHash = crypto.createHash('sha256').update(oldWebview).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => patchExtension(root, 'dry-run', backups), /旧版本补丁.*restore/);
    assert.throws(() => patchExtension(root, 'apply', backups), /旧版本补丁.*restore/);
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    assert.equal(patchExtension(root, 'restore', backups).status, 'not-applied');
    // 版本标签变动但实际加载资产完全相同时仍能应用；不放开未知字节。
    const futurePackage = JSON.parse(originals.get('package.json').toString());
    futurePackage.version = '99.0.0';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(futurePackage));
    fs.writeFileSync(path.join(root, 'webview/index.html'), `<link rel="modulepreload" href="./assets/${asset}">`);
    assert.equal(patchExtension(root, 'dry-run', backups).status, 'ready');
    assert.equal(patchExtension(root, 'apply', backups).status, 'applied');
    assert.equal(patchExtension(root, 'dry-run', backups).status, 'already-applied');
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    fs.appendFileSync(host, '\n// 未审计的未来版本');
    assert.throws(() => patchExtension(root, 'apply', backups), /尚不兼容/);
    fs.writeFileSync(host, originals.get('out/extension.js'));
    fs.writeFileSync(path.join(root, 'package.json'), originals.get('package.json'));
    fs.appendFileSync(host, '\n');
    const changed = fs.readFileSync(host);
    assert.throws(() => patchExtension(root, 'apply', backups), /哈希不匹配/);
    assert.deepEqual(fs.readFileSync(host), changed);
  });
}
