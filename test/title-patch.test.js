'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { patchExtension, getCorePatches, transformHost, transformWebview, updatePanelTitle, observeTitle, waitForOnboardingState } = require('../src/compatibility/title-patch');
const { getNativePatchFiles, getNativeDependencies } = require('../src/compatibility/native-history-patch');
const { createCompatibilityManager } = require('../src/compatibility/compatibility-manager');

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
  '26.917.61114': 'app-initial-801a1845d914.js',
};

const nuxFixture = 'function lQn(){let{data:e,isLoading:t}=$g(xr.NUX_2025_09_15),{authMethod:n}=fu();if(!t){if(e)return`none`;switch(n){case`chatgpt`:return`2025-09-15-full-chatgpt-auth`;case`apikey`:return`2025-09-15-apikey-auth`;case null:return`none`}}}';

// 执行变换前后的函数，复现 pending + idle 误进引导，而非只断言补丁文本存在。
function verifyOnboardingGate(original, patched, name, queryHook, authHook, nuxConstant = 'xr') {
  let state, authMethod = 'chatgpt';
  const browser = browserFixture();
  const context = { document: browser.doc, URLSearchParams, [nuxConstant]: { NUX_2025_09_15: 'nux' },
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

test('新版宿主保留官方 replaceCurrentEditor 导航分支', () => {
  const anchor = 'case"navigate-in-new-editor-tab":{let n=hM(r.path);';
  const original = `${anchor}if(!r.replaceCurrentEditor){return 'new'}return 'replace'}`;
  const transformed = transformHost(original, '26.917.61114');
  assert.equal(transformed.slice(transformed.indexOf(anchor)), original);
  assert.equal(transformed.split('case"codex-multi-tab-title":').length, 2);
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

test('新版 webview 仅在引导查询成功后进入首次引导判断', () => {
  const fixture = 'function pcr(){let{data:e,isLoading:t}=iS(Cs.NUX_2025_09_15),{authMethod:n}=Zl();if(!t)return e||n==null?`none`:n===`chatgptAuthTokens`||n===`chatgpt`?`2025-09-15-full-chatgpt-auth`:`2025-09-15-apikey-auth`}';
  const transformed = transformWebview(`hp=acquireVsCodeApi();${fixture}`, 'hp');
  let state = { data: false, isLoading: false, status: 'pending' };
  const document = browserFixture().doc;
  const context = { document, URLSearchParams, Cs: { NUX_2025_09_15: 'nux' },
    iS: () => state, Zl: () => ({ authMethod: 'chatgpt' }) };
  const before = vm.runInNewContext(`${fixture};pcr`, context);
  const after = vm.runInNewContext(`${transformed.slice(transformed.indexOf('function pcr()'))};pcr`, context);
  assert.equal(before(), '2025-09-15-full-chatgpt-auth');
  assert.equal(after(), undefined);
  state = { ...state, status: 'success' };
  assert.equal(after(), '2025-09-15-full-chatgpt-auth');
});

const ideNuxFixture = 'function v(){let{data:e,isLoading:t}=a(g),{authMethod:n}=f();if(l?.ideOnboarding==null)return`none`;if(!t)return e?.completed||n==null?`none`:n===`chatgptAuthTokens`||n===`chatgpt`?`2025-09-15-full-chatgpt-auth`:`2025-09-15-apikey-auth`}';

// 26.1021 的引导数据为 { completed }；IDE 无引导服务时官方直接跳过，门控须在该判断之后。
function verifyIdeOnboardingGate(original, patched) {
  let state, authMethod = 'chatgpt';
  const context = { document: browserFixture().doc, URLSearchParams, g: 'ide-onboarding', l: { ideOnboarding: {} },
    a(query) { assert.equal(query, 'ide-onboarding'); return state; }, f() { return { authMethod }; } };
  const before = vm.runInNewContext(`${original};v`, context);
  const after = vm.runInNewContext(`${patched};v`, context);
  const failure = new Error('读取引导状态失败');
  const pending = { status: 'pending', fetchStatus: 'idle', isLoading: false, data: undefined };
  const incomplete = { status: 'success', fetchStatus: 'idle', isLoading: false, data: { completed: false } };
  const failed = { status: 'error', fetchStatus: 'idle', isLoading: false, data: undefined, error: failure };
  state = pending;
  assert.equal(before(), '2025-09-15-full-chatgpt-auth');
  assert.equal(after(), undefined);
  state = { status: 'pending', fetchStatus: 'fetching', isLoading: true, data: undefined };
  assert.equal(after(), undefined);
  state = { ...incomplete, data: { completed: true } };
  assert.equal(after(), 'none');
  state = incomplete;
  assert.equal(after(), '2025-09-15-full-chatgpt-auth');
  authMethod = 'apikey';
  assert.equal(after(), '2025-09-15-apikey-auth');
  state = failed;
  assert.throws(after, error => error === failure);
  // 查询因无服务而保持禁用的 pending 时，辅助标签也必须按官方结果放行。
  context.l = { ideOnboarding: null };
  for (const next of [pending, failed]) {
    state = next;
    assert.equal(after(), 'none');
    assert.equal(after(), before());
  }
  context.l = { ideOnboarding: {} };
  for (const route of [null, '/local/a', '/extension/panel/new', '/extension/panel/new?codexMultiTab=']) {
    context.document = browserFixture(route).doc;
    for (const next of [pending, incomplete, failed]) {
      state = next;
      assert.equal(after(), before());
    }
  }
}

test('26.1021 拆分分块：API 分块只获取一次 API 并观察标题，引导分块在服务判断后门控', () => {
  const patches = getCorePatches('26.1021.22027');
  assert.deepEqual(patches.map(patch => patch.file), ['out/extension.js', 'webview/assets/message-bus-4113ba7287d7.js',
    'webview/assets/use-nux-cbb39779849d.js', 'webview/assets/app-runtime-ca74aa759873.js']);
  const [, api, onboarding] = patches;
  const browser = browserFixture();
  let acquisitions = 0;
  const lazy = api.transform('var c,ready;function l(){if(ready)return;ready=!0;c=acquireVsCodeApi()}l();l();');
  vm.runInNewContext(lazy, { document: browser.doc, window: browser.win, URLSearchParams,
    acquireVsCodeApi() { acquisitions++; return browser.api; } });
  assert.equal(acquisitions, 1);
  assert.equal(browser.messages[0].title, 'Codex');
  browser.doc.title = '拆分分块会话';
  browser.mutate(); browser.flush();
  assert.equal(browser.messages[1].title, '拆分分块会话');
  assert.throws(() => api.transform('var c;'), /特征/);
  verifyIdeOnboardingGate(ideNuxFixture, onboarding.transform(ideNuxFixture));
  // 锚点必须包含官方的无服务判断，避免门控被提前到该判断之前。
  assert.throws(() => onboarding.transform(ideNuxFixture.replace('if(l?.ideOnboarding==null)return`none`;', '')), /特征/);
  assert.throws(() => onboarding.transform(ideNuxFixture.repeat(2)), /特征/);
  assert.throws(() => transformWebview(`c=acquireVsCodeApi();${ideNuxFixture}`, 'c'), /未知 webview/);
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
    const [api, name, queryHook, authHook, nuxConstant] = {
      '26.5908.31748': ['qf', 'lQn', '$g', 'fu', 'xr'],
      '26.908.40401': ['Jf', 'pQn', 'n_', 'pu', 'xr'],
      '26.917.61114': ['hp', 'pcr', 'iS', 'Zl', 'Cs'],
    }[version];
    const originalWebview = originals.get(`webview/assets/${asset}`).toString();
    const patchedWebview = fs.readFileSync(path.join(root, `webview/assets/${asset}`), 'utf8');
    // 真实 bundle 的函数边界由相邻 var 声明限定，两版本都运行原函数和实际变换后的函数。
    const extractNux = source => source.slice(source.indexOf(`function ${name}()`), source.indexOf('var ', source.indexOf(`function ${name}()`)));
    verifyOnboardingGate(extractNux(originalWebview), extractNux(patchedWebview), name,
      queryHook, authHook, nuxConstant);
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
      if (patch.file === 'out/extension.js') source = transformHost(source, version);
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
    const hostAnchor = version === '26.917.61114'
      ? 'case"navigate-in-new-editor-tab":{let n=hM(r.path);'
      : 'case"navigate-in-new-editor-tab":{let n=pI(r.path);';
    const oldHost = originals.get('out/extension.js').toString().replace(hostAnchor,
      () => `case"codex-multi-tab-title":{(${updatePanelTitle.toString()})(this,e,r.title);break;}${hostAnchor}`);
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

// 只提供核心资产，模拟原生历史分块未审计或缺失时的安全降级。
const coreOnlyVersions = {
  '26.917.62051': { asset: 'app-initial-de4359f78ed1.js' },
  '26.1002.51308': { asset: 'app-initial-d277996860bb.js', nux: ['CBi', 'DC', 'jd', 'au'], location: ['lst', 'aa', 'K'] },
  '26.1007.21434': { asset: 'app-initial-c014f9ee4429.js', nux: ['FGi', 'UC', 'Lf', 'hs'], location: ['alt', 'ca', 'X'] },
  '26.51007.21434': { asset: 'app-initial-41ab338a184f.js', nux: ['FGi', 'UC', 'Lf', 'hs'], location: ['alt', 'ca', 'X'] },
};

// 按括号边界截取压缩包中的单个函数，执行真实原函数与补丁后的函数。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(){`);
  assert.ok(start >= 0, `缺少函数 ${name}`);
  let index = source.indexOf('{', start), depth = 0;
  do {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    index++;
  } while (depth > 0 && index < source.length);
  return source.slice(start, index);
}

// 本机已应用增强时，从经哈希核对的运行时备份取原件，仍只修改临时副本。
function officialOriginal(version, installed, file) {
  const identity = crypto.createHash('sha256').update(fs.realpathSync(installed)).digest('hex').slice(0, 16);
  const backup = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups', `${version}-${identity}`);
  const manifestFile = path.join(backup, 'manifest.json');
  const entry = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files.find(item => item.file === file) : undefined;
  if (!entry) return fs.readFileSync(path.join(installed, file));
  const bytes = fs.readFileSync(path.join(backup, entry.backup));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.originalHash);
  return bytes;
}

function installedRoot(version) {
  const fixture = process.env.CODEX_MULTI_TAB_OFFICIAL_ROOT;
  if (fixture && fs.existsSync(path.join(fixture, 'package.json'))) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version === version) return fixture;
    } catch { /* fall through to the normal installed extension path */ }
  }
  return path.join(os.homedir(), `.vscode/extensions/openai.chatgpt-${version}-darwin-arm64`);
}

for (const [version, { asset, nux, location }] of Object.entries(coreOnlyVersions)) {
  test(`${version} 核心资产可降级应用，原生历史资产不可用时仍可恢复`, t => {
    const installed = installedRoot(version);
    if (!fs.existsSync(installed)) return t.skip(`本机未安装 ${version}`);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-core-only-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'extension'), backups = path.join(temporary, 'backups');
    const host = 'out/extension.js', web = `webview/assets/${asset}`;
    const originals = new Map();
    for (const file of ['package.json', host, 'webview/index.html', web]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      originals.set(file, officialOriginal(version, installed, file));
      fs.writeFileSync(target, originals.get(file));
    }
    const dry = patchExtension(root, 'dry-run', backups);
    assert.equal(dry.status, 'ready');
    assert.equal(dry.degraded, true);
    assert.deepEqual(dry.files, [host, web]);
    assert.equal(patchExtension(root, 'apply', backups).degraded, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'core-only');
    assert.equal(manifest.patchVersion, require('../package.json').version);
    const patchedHost = fs.readFileSync(path.join(root, host), 'utf8');
    const patchedWeb = fs.readFileSync(path.join(root, web), 'utf8');
    new vm.Script(patchedHost);
    for (const marker of ['case"codex-multi-tab-title"', 'case"codex-multi-tab-route"', 'codexMultiTab.internalBridge']) {
      assert.equal(patchedHost.split(marker).length, 2, marker);
    }
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patchedWeb, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    if (location) {
      const [exported, alias, react] = location;
      assert.equal(patchedWeb.split(`${exported} as codexMultiTabOriginalLocation,`).length, 2);
      assert.match(patchedWeb, new RegExp(`\\nfunction ${alias}\\(\\)\\{const location=codexMultiTabOriginalLocation\\(\\);${react}\\(\\)\\.useLayoutEffect\\(`));
    }
    if (nux) {
      const [name, queryHook, authHook, nuxConstant] = nux;
      verifyOnboardingGate(extractFunction(originals.get(web).toString(), name), extractFunction(patchedWeb, name),
        name, queryHook, authHook, nuxConstant);
    }
    const already = patchExtension(root, 'dry-run', backups);
    assert.equal(already.status, 'already-applied');
    assert.equal(already.degraded, true);
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
  });
}

for (const version of ['26.1007.21434', '26.51007.21434']) {
  const asset = coreOnlyVersions[version].asset;
  const coreFiles = ['out/extension.js', `webview/assets/${asset}`];

  function fixture(t, coreOnly = false) {
    const installed = installedRoot(version);
    if (!fs.existsSync(installed)) {
      t.skip(`本机未安装 ${version}`);
      return;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-migration-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'extension'), backups = path.join(temporary, 'backups');
    const nativePatches = getNativePatchFiles(version);
    const dependencies = getNativeDependencies(version);
    assert.ok(nativePatches.length > 0, '已审计版本必须提供原生历史补丁');
    assert.ok(dependencies.length > 0, '已审计版本必须校验原生历史依赖');
    const files = [...new Set(['package.json', 'webview/index.html', ...coreFiles,
      ...nativePatches.map(item => item.file), ...dependencies.map(item => item.file)])];
    const originals = new Map(files.map(file => [file, officialOriginal(version, installed, file)]));
    function writeOriginal(file) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, originals.get(file));
    }
    for (const file of coreOnly ? ['package.json', 'webview/index.html', ...coreFiles] : files) writeOriginal(file);
    return { root, backups, nativePatches, dependencies, files, originals, writeOriginal };
  }

  test(`${version} 真实全量资产：原生历史应用、幂等、语法检查及逐字节恢复`, t => {
    const data = fixture(t);
    if (!data) return;
    const { root, backups, nativePatches, dependencies, originals } = data;
    const expected = [...new Set([...coreFiles, ...nativePatches.map(item => item.file)])];
    const dry = patchExtension(root, 'dry-run', backups);
    assert.equal(dry.status, 'ready');
    assert.equal(dry.degraded, false);
    assert.deepEqual(dry.files, expected);
    assert.equal(fs.existsSync(backups), false);
    const applied = patchExtension(root, 'apply', backups);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.degraded, false);
    assert.deepEqual(applied.files, expected);
    const manifestPath = path.join(backups, fs.readdirSync(backups)[0], 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.notEqual(manifest.mode, 'core-only');
    assert.deepEqual(manifest.files.map(entry => entry.file), expected);
    const patched = new Map(expected.map(file => [file, fs.readFileSync(path.join(root, file))]));
    for (const [file, bytes] of patched) {
      assert.notDeepEqual(bytes, originals.get(file), file);
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: bytes, encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${file}: ${syntax.stderr}`);
    }
    for (const action of ['dry-run', 'apply']) {
      const repeated = patchExtension(root, action, backups);
      assert.equal(repeated.status, 'already-applied');
      assert.equal(repeated.degraded, false);
      for (const [file, bytes] of patched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
    }
    for (const dependency of dependencies) {
      if (!patched.has(dependency.file)) assert.deepEqual(fs.readFileSync(path.join(root, dependency.file)), originals.get(dependency.file));
    }
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
    assert.equal(patchExtension(root, 'restore', backups).status, 'not-applied');
  });

  test(`${version} core-only 安全迁移为全量增强，损坏资产和备份不得触发覆盖`, t => {
    const data = fixture(t, true);
    if (!data) return;
    const { root, backups, dependencies, files, originals, writeOriginal } = data;
    const initial = patchExtension(root, 'apply', backups);
    assert.equal(initial.status, 'applied');
    assert.equal(initial.degraded, true);
    const corePatched = new Map(coreFiles.map(file => [file, fs.readFileSync(path.join(root, file))]));
    const backup = path.join(backups, fs.readdirSync(backups)[0]);
    const manifestPath = path.join(backup, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.mode, 'core-only');
    manifest.patchVersion = '0.5.8';
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestPath, manifestBytes);
    for (const file of files) if (!fs.existsSync(path.join(root, file))) writeOriginal(file);

    // 新增分块的依赖不可信时，保留已验证的核心补丁，不自动恢复或升级。
    const dependency = dependencies.find(item => !coreFiles.includes(item.file));
    assert.ok(dependency, '需要独立原生历史依赖');
    const dependencyPath = path.join(root, dependency.file);
    fs.appendFileSync(dependencyPath, '\n// 外部变更');
    const changedDependency = fs.readFileSync(dependencyPath);
    for (const action of ['dry-run', 'apply']) {
      const degraded = patchExtension(root, action, backups);
      assert.equal(degraded.status, 'already-applied');
      assert.equal(degraded.degraded, true);
      assert.deepEqual(fs.readFileSync(dependencyPath), changedDependency);
      for (const [file, bytes] of corePatched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    }
    writeOriginal(dependency.file);

    // 有可升级资产也必须先验证原备份和当前文件，再允许 REAPPLY_REQUIRED。
    const backupPath = path.join(backup, manifest.files[0].backup);
    const originalBackup = fs.readFileSync(backupPath);
    fs.appendFileSync(backupPath, '\ncorrupted');
    for (const action of ['dry-run', 'apply', 'restore']) {
      assert.throws(() => patchExtension(root, action, backups), /备份内容校验失败/);
      for (const [file, bytes] of corePatched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    }
    fs.writeFileSync(backupPath, originalBackup);
    const host = path.join(root, coreFiles[0]);
    fs.appendFileSync(host, '\n// 外部变更');
    const changedHost = fs.readFileSync(host);
    for (const action of ['dry-run', 'apply', 'restore']) {
      assert.throws(() => patchExtension(root, action, backups), /拒绝覆盖/);
      assert.deepEqual(fs.readFileSync(host), changedHost);
    }
    fs.writeFileSync(host, corePatched.get(coreFiles[0]));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, patchVersion: '99.0.0' }));
    for (const action of ['dry-run', 'apply', 'restore']) {
      assert.throws(() => patchExtension(root, action, backups), error => error.code === 'CODEX_MULTI_TAB_NEWER_PATCH_PRESENT');
      for (const [file, bytes] of corePatched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    }
    fs.writeFileSync(manifestPath, manifestBytes);

    for (const action of ['dry-run', 'apply']) {
      assert.throws(() => patchExtension(root, action, backups), error => error.code === 'CODEX_MULTI_TAB_REAPPLY_REQUIRED');
      assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
      for (const [file, bytes] of corePatched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
    }
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
    const full = patchExtension(root, 'apply', backups);
    assert.equal(full.status, 'applied');
    assert.equal(full.degraded, false);
    assert.ok(full.files.length > coreFiles.length);
    assert.equal(patchExtension(root, 'apply', backups).status, 'already-applied');
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
  });

  test(`${version} 兼容管理器自动迁移真实核心补丁，提示完整增强且不自动重载`, async t => {
    const data = fixture(t, true);
    if (!data) return;
    const { root, files, originals, writeOriginal } = data;
    const storage = path.dirname(data.backups);
    const backups = path.join(storage, 'patch-backups');
    assert.equal(patchExtension(root, 'apply', backups).degraded, true);
    for (const file of files) if (!fs.existsSync(path.join(root, file))) writeOriginal(file);
    const actions = [], warnings = [], notices = [], commands = [];
    let listenerDisposed = false;
    const vscode = {
      extensions: {
        getExtension: () => ({ extensionPath: root, packageJSON: { version } }),
        onDidChange: () => ({ dispose() { listenerDisposed = true; } }),
      },
      window: {
        showWarningMessage: async message => { warnings.push(message); },
        showInformationMessage: async (message, button) => { notices.push({ message, button }); },
      },
      commands: { executeCommand: async command => { commands.push(command); } },
    };
    const manager = createCompatibilityManager(vscode, { globalStorageUri: { fsPath: storage } },
      (directory, action, backupRoot) => {
        actions.push(action);
        assert.equal(directory, root);
        assert.equal(backupRoot, backups);
        return patchExtension(directory, action, backupRoot);
      });
    t.after(() => manager.dispose());
    await manager.requestCheck();
    assert.deepEqual(actions.slice(0, 4), ['dry-run', 'restore', 'dry-run', 'apply']);
    assert.equal(actions.filter(action => action === 'apply').length, 1);
    assert.deepEqual(warnings, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /增强已适配当前官方扩展/);
    assert.doesNotMatch(notices[0].message, /暂不可用/);
    assert.equal(notices[0].button, '重载窗口');
    assert.deepEqual(commands, []);
    const result = patchExtension(root, 'dry-run', backups);
    assert.equal(result.status, 'already-applied');
    assert.equal(result.degraded, false);
    await manager.requestCheck();
    assert.equal(notices.length, 1);
    manager.dispose();
    assert.equal(listenerDisposed, true);
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
  });
}

// 26.1021 起核心补丁分布在 API、首次引导和路由分块；入口分块只用于识别版本，不得改动。
const splitVersions = {
  '26.1021.22027': {
    entry: 'webview/assets/app-initial-13f932cb2f13.js',
    api: 'webview/assets/message-bus-4113ba7287d7.js',
    onboarding: 'webview/assets/use-nux-cbb39779849d.js',
    location: 'webview/assets/app-runtime-ca74aa759873.js',
  },
};

for (const [version, assets] of Object.entries(splitVersions)) {
  test(`${version} 真实拆分分块：核心降级应用、幂等、门控执行、未知版本拒绝及逐字节恢复`, t => {
    const installed = installedRoot(version);
    if (!fs.existsSync(installed)) return t.skip(`本机未安装 ${version}`);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-split-core-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'extension'), backups = path.join(temporary, 'backups');
    const host = 'out/extension.js';
    const patchedFiles = [host, assets.api, assets.onboarding, assets.location];
    const originals = new Map();
    for (const file of ['package.json', 'webview/index.html', assets.entry, ...patchedFiles]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      originals.set(file, officialOriginal(version, installed, file));
      fs.writeFileSync(target, originals.get(file));
    }
    assert.deepEqual(getNativePatchFiles(version), []);
    const dry = patchExtension(root, 'dry-run', backups);
    assert.equal(dry.status, 'ready');
    assert.equal(dry.degraded, true);
    assert.deepEqual(dry.files, patchedFiles);
    assert.equal(fs.existsSync(backups), false);
    assert.equal(patchExtension(root, 'apply', backups).degraded, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'core-only');
    assert.equal(manifest.patchVersion, require('../package.json').version);
    assert.deepEqual(manifest.files.map(entry => entry.file), patchedFiles);
    assert.deepEqual(fs.readFileSync(path.join(root, assets.entry)), originals.get(assets.entry));

    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const patchedHost = read(host);
    new vm.Script(patchedHost);
    for (const marker of ['case"codex-multi-tab-title"', 'case"codex-multi-tab-route"', 'codexMultiTab.internalBridge', 'e.push($e),(function registerSidebarBridge(']) {
      assert.equal(patchedHost.split(marker).length, 2, marker);
    }
    for (const file of [assets.api, assets.onboarding, assets.location]) {
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: read(file), encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${file}: ${syntax.stderr}`);
      assert.notDeepEqual(fs.readFileSync(path.join(root, file)), originals.get(file), file);
    }
    const api = read(assets.api);
    assert.equal(api.split('acquireVsCodeApi()').length, 2);
    assert.equal(api.split(`c=acquireVsCodeApi();(${observeTitle.toString()})(c)`).length, 2);
    const location = read(assets.location);
    assert.equal(location.split('E as codexMultiTabOriginalLocation,').length, 2);
    assert.equal(location.split('import{c as codexMultiTabApi,i as I,n as ye,r as be}from"./message-bus-4113ba7287d7.js"').length, 2);
    assert.match(location, /\nfunction W\(\)\{const location=codexMultiTabOriginalLocation\(\);N\(\)\.useLayoutEffect\(/);
    verifyIdeOnboardingGate(extractFunction(originals.get(assets.onboarding).toString(), 'v'), extractFunction(read(assets.onboarding), 'v'));

    const patched = new Map(patchedFiles.map(file => [file, fs.readFileSync(path.join(root, file))]));
    for (const action of ['dry-run', 'apply']) {
      const repeated = patchExtension(root, action, backups);
      assert.equal(repeated.status, 'already-applied');
      assert.equal(repeated.degraded, true);
      for (const [file, bytes] of patched) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
    }
    assert.equal(patchExtension(root, 'restore', backups).status, 'restored');
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);

    // 版本号变化但全部审计字节相同才复用配置；任一拆分分块变化都拒绝且不写入。
    const pkg = JSON.parse(originals.get('package.json'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, version: `${version}9` }));
    assert.equal(patchExtension(root, 'dry-run', backups).status, 'ready');
    fs.appendFileSync(path.join(root, assets.onboarding), '\n// 未审计的未来版本');
    const changed = fs.readFileSync(path.join(root, assets.onboarding));
    assert.throws(() => patchExtension(root, 'apply', backups), /尚不兼容/);
    fs.writeFileSync(path.join(root, 'package.json'), originals.get('package.json'));
    assert.throws(() => patchExtension(root, 'apply', backups), /哈希不匹配/);
    assert.deepEqual(fs.readFileSync(path.join(root, assets.onboarding)), changed);
    for (const file of [host, assets.api, assets.location]) assert.deepEqual(fs.readFileSync(path.join(root, file)), originals.get(file), file);
    assert.deepEqual(fs.readdirSync(backups).filter(name => !name.startsWith('.')), []);
  });
}
