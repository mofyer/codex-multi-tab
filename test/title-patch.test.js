'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { patchExtension, transformHost, transformWebview, updatePanelTitle, observeTitle, waitForOnboardingState } = require('../title-patch');

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
    const files = ['package.json', 'out/extension.js', `webview/assets/${asset}`];
    const originals = new Map();
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      // 本机已应用补丁时使用经过哈希核对的原件备份，仍只测试临时副本。
      const rootHash = crypto.createHash('sha256').update(fs.realpathSync(installed)).digest('hex').slice(0, 16);
      const backup = path.join(__dirname, '..', 'backups', `${version}-${rootHash}`);
      const manifestFile = path.join(backup, 'manifest.json');
      let bytes = fs.readFileSync(path.join(installed, file));
      if (file !== 'package.json' && fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        assert.equal(manifest.root, fs.realpathSync(installed));
        const entry = manifest.files.find(item => item.file === file);
        assert.ok(entry);
        bytes = fs.readFileSync(path.join(backup, entry.backup));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.originalHash);
      }
      originals.set(file, bytes);
      fs.writeFileSync(path.join(root, file), bytes);
    }
    assert.equal(patchExtension(root, 'dry-run', backups).status, 'ready');
    assert.equal(fs.existsSync(backups), false);
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
        if (String(to).endsWith(asset)) throw new Error('模拟第二文件写入失败');
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
    fs.appendFileSync(host, '\n// other edit');
    assert.throws(() => patchExtension(root, 'restore', backups), /拒绝覆盖/);
    assert.equal(fs.readFileSync(host, 'utf8').endsWith('// other edit'), true);
    fs.writeFileSync(host, patched);
    // 模拟旧标题补丁与其真实清单：新版必须拒绝假报已应用，仍允许恢复旧原件。
    const backupDirectory = path.join(backups, fs.readdirSync(backups)[0]);
    const manifestPath = path.join(backupDirectory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
    fs.appendFileSync(host, '\n');
    const changed = fs.readFileSync(host);
    assert.throws(() => patchExtension(root, 'apply', backups), /哈希不匹配/);
    assert.deepEqual(fs.readFileSync(host), changed);
  });
}
