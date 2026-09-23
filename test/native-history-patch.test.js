'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { getNativePatchFiles, getNativeDependencies, isHelperDocument, nativePinnedThreads, navigateHistoryInPlace, partitionNativeHistory } = require('../src/compatibility/native-history-patch');

const documentFor = route => ({ querySelector: () => route == null ? null : { content: route } });

function stateFor(initial = []) {
  const records = { 'pinned-thread-ids': initial, unrelated: 'retain' };
  let queue = Promise.resolve();
  const events = [];
  return {
    records, events, fail: false,
    enqueueUpdate(key, callback) {
      assert.equal(key, 'codex-multi-tab-native-pin-operation');
      const operation = queue.catch(() => {}).then(callback);
      queue = operation;
      return operation;
    },
    async get(key) { assert.equal(key, 'persisted-atom-state'); return records; },
    async updatePersistedAtomValue(key, value) {
      await new Promise(resolve => setImmediate(resolve));
      if (this.fail) throw new Error('storage unavailable');
      records[key] = value;
      events.push({ key, value });
    },
  };
}

test('辅助面板标记只读原始路由，普通页面不增强', () => {
  assert.equal(isHelperDocument(documentFor('/extension/panel/new?codexMultiTab=abc')), true);
  for (const route of [null, '/local/abc', '/new?other=codexMultiTab', '/new?codexMultiTab=']) {
    assert.equal(isHelperDocument(documentFor(route)), false);
  }
});

test('原生置顶读写与取消置顶持久化在同一个官方 atom，保留其他记录', async () => {
  const state = stateFor(['first']);
  assert.deepEqual(await nativePinnedThreads(state), { threadIds: ['first'] });
  assert.deepEqual(await nativePinnedThreads(state, { threadId: 'second', pinned: true, beforeThreadId: 'first' }), { success: true });
  assert.deepEqual(await nativePinnedThreads(state), { threadIds: ['second', 'first'] });
  await nativePinnedThreads(state, { threadId: 'first', pinned: false });
  assert.deepEqual(state.records, { 'pinned-thread-ids': ['second'], unrelated: 'retain' });
  assert.equal(state.events.every(event => event.key === 'pinned-thread-ids'), true);
});

test('并发置顶不丢更新、重复点击幂等，读取等待写入', async () => {
  const state = stateFor();
  const requests = [
    nativePinnedThreads(state, { threadId: 'alpha', pinned: true }),
    nativePinnedThreads(state, { threadId: 'beta', pinned: true }),
    nativePinnedThreads(state, { threadId: 'alpha', pinned: true }),
    nativePinnedThreads(state),
  ];
  const results = await Promise.all(requests);
  assert.deepEqual(results.at(-1), { threadIds: ['beta', 'alpha'] });
});

test('存储失败返回异常而非假成功，下一次操作可恢复', async () => {
  const state = stateFor(['saved']);
  state.fail = true;
  await assert.rejects(nativePinnedThreads(state, { threadId: 'failed', pinned: true }), /storage unavailable/);
  assert.deepEqual(state.records['pinned-thread-ids'], ['saved']);
  state.fail = false;
  await nativePinnedThreads(state, { threadId: 'recovered', pinned: true });
  assert.deepEqual((await nativePinnedThreads(state)).threadIds, ['saved', 'recovered']);
});

test('无效参数与损坏官方数据拒绝写入', async () => {
  for (const input of [{ threadId: '', pinned: true }, { threadId: '../x', pinned: true }, { threadId: 'x', pinned: 'yes' }, { threadId: 'x', pinned: true, beforeThreadId: {} }]) {
    const state = stateFor();
    await assert.rejects(nativePinnedThreads(state, input), /参数无效/);
    assert.equal(state.events.length, 0);
  }
  await assert.rejects(nativePinnedThreads(stateFor({ invalid: true })), /格式无效/);
});

function navigationFixture(route = '/new?codexMultiTab=qa') {
  const panel = { name: 'source' };
  const otherPanel = { name: 'active-other' };
  const sent = [];
  let alive = true;
  let resolveChoice;
  const prompts = [];
  const host = {
    editorPanels: new Map([[panel, { initialRoute: route }], [otherPanel, { initialRoute: '/new?codexMultiTab=other' }]]),
    findPanelByWebview: webview => webview === 'source-webview' ? panel : undefined,
    isPanelAlive: target => target === panel && alive,
    sendMessageToPanel: (target, message) => sent.push({ target, message }),
  };
  const vscode = { window: { showWarningMessage: (...args) => {
    prompts.push(args);
    return new Promise(resolve => { resolveChoice = resolve; });
  } } };
  return { host, vscode, panel, sent, prompts, close: () => { alive = false; }, choose: value => resolveChoice(value) };
}

test('历史选择确认后只在消息来源面板切换，即使当前焦点已变化', async () => {
  const fixture = navigationFixture();
  const operation = navigateHistoryInPlace(fixture.host, fixture.vscode, 'source-webview', { path: '/local/qa-id' });
  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.prompts[0][1].modal, true);
  assert.equal(fixture.sent.length, 0);
  fixture.choose('继续切换');
  assert.equal(await operation, true);
  assert.deepEqual(fixture.sent, [{ target: fixture.panel, message: { type: 'navigate-to-route', path: '/local/qa-id' } }]);
});

test('取消或等待确认时关闭面板不切换、不销毁其他面板', async () => {
  for (const close of [false, true]) {
    const fixture = navigationFixture();
    const operation = navigateHistoryInPlace(fixture.host, fixture.vscode, 'source-webview', { path: '/local/qa-id' });
    if (close) fixture.close();
    fixture.choose(close ? '继续切换' : undefined);
    assert.equal(await operation, true);
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.host.editorPanels.size, 2);
  }
});

test('新会话、云端、外部路径与普通面板仍由官方导航处理', async () => {
  for (const destination of ['/', '/new', '/extension/panel/new', '/remote/id', '/local/id/extra', 'https://example.test']) {
    const fixture = navigationFixture();
    assert.equal(await navigateHistoryInPlace(fixture.host, fixture.vscode, 'source-webview', { path: destination }), false);
    assert.equal(fixture.prompts.length, 0);
  }
  const fixture = navigationFixture('/local/ordinary');
  assert.equal(await navigateHistoryInPlace(fixture.host, fixture.vscode, 'source-webview', { path: '/local/qa-id' }), false);
  assert.equal(fixture.prompts.length, 0);
});

test('原生列表分组保留云端和待创建行，按官方置顶顺序去重', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const items = [{ kind: 'local', key: 'a', conversation: a }, { kind: 'remote', key: 'remote', task: { id: 'a' } }, { kind: 'local', key: 'pending', conversation: null }, { kind: 'local', key: 'b', conversation: b }];
  const result = partitionNativeHistory(items, [a, b, c], ['b', 'a'], true);
  assert.deepEqual(result.pinned.map(item => item.conversation.id), ['b', 'a']);
  assert.deepEqual(result.items.map(item => item.key), ['remote', 'pending']);
  assert.deepEqual(result.conversations, [c]);
  const ordinary = partitionNativeHistory(items, [a, b, c], ['a'], false);
  assert.equal(ordinary.items, items);
  assert.deepEqual(ordinary.pinned, []);
});

test('较早置顶只在本地集合中也会进入置顶区，不会过滤丢失', () => {
  const earlier = { id: 'earlier', title: 'Old conversation' };
  const result = partitionNativeHistory([], [earlier], ['missing', 'earlier'], true);
  assert.equal(result.pinned.length, 1);
  assert.equal(result.pinned[0].conversation, earlier);
  assert.equal(result.conversations.length, 0);
});

function originalAsset(root, entry) {
  const bytes = fs.readFileSync(path.join(root, entry.file));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  if (hash(bytes) === entry.originalHash) return bytes.toString('utf8');
  const backupRoots = [process.env.CODEX_MULTI_TAB_TEST_BACKUP_ROOT,
    path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups'),
    path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/yafan-local.codex-multi-tab/patch-backups'),
    path.join(__dirname, '../backups')].filter(Boolean);
  for (const backupRoot of backupRoots) {
    if (!fs.existsSync(backupRoot)) continue;
    for (const directory of fs.readdirSync(backupRoot)) {
      const manifestPath = path.join(backupRoot, directory, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.root !== root) continue;
      const saved = manifest.files.find(file => file.file === entry.file);
      if (!saved) continue;
      const original = fs.readFileSync(path.join(backupRoot, directory, saved.backup));
      if (hash(original) === entry.originalHash) return original.toString('utf8');
    }
  }
  // 发行缓存是安装前的真实原件；仅在审计哈希一致时采用，不能用重建夹具替代。
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const cachedVsix = path.join(os.homedir(), 'Library/Application Support/Code/CachedExtensionVSIXs', `openai.chatgpt-${version}-darwin-arm64`);
  if (fs.existsSync(cachedVsix)) {
    const original = spawnSync('unzip', ['-p', cachedVsix, `extension/${entry.file}`], { maxBuffer: 30 * 1024 * 1024 });
    assert.equal(original.status, 0, original.stderr?.toString());
    if (hash(original.stdout) === entry.originalHash) return original.stdout.toString('utf8');
  }
  throw new Error(`找不到已校验原件：${entry.file}`);
}

for (const version of ['26.5908.31748', '26.908.40401', '26.917.61114']) {
  const root = path.join(os.homedir(), `.vscode/extensions/openai.chatgpt-${version}-darwin-arm64`);
  test(`已审计 ${version} 真实资产转换、语法、原生 JSX 选择与菜单行为`, { skip: !fs.existsSync(root) }, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-patch-test-'));
    try {
      const modern = version === '26.917.61114';
      for (const entry of getNativeDependencies(version)) {
        const bytes = fs.readFileSync(path.join(root, entry.file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.originalHash);
      }
      const patches = getNativePatchFiles(version);
      let host, app, header;
      for (const [index, entry] of patches.entries()) {
        const source = originalAsset(root, entry);
        const transformed = entry.transform(source);
        const file = path.join(temporary, index === 0 ? 'host.cjs' : `${index}.mjs`);
        fs.writeFileSync(file, transformed);
        const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(check.status, 0, check.stderr);
        assert.throws(() => entry.transform('unsupported bundle'), /特征/);
        if (index === 0) host = transformed;
        if (index === 1) app = transformed;
        if (index === 2) header = transformed;
      }
      const old = version === '26.5908.31748';
      // 执行真实转换后的空态判据：仅命中置顶会话时不能同时显示“未找到”。
      const recent = old ? 'I' : modern ? 'F' : 'P', local = old ? 'F' : modern ? 'P' : 'N', query = old || modern ? 'j' : 'A';
      const recentPrefix = header.match(new RegExp(`${recent}\\.length===0\\?([^]*?)${query}\\?`))?.[0];
      const localPrefix = header.match(new RegExp(`${local}\\.length\\?${local}\\.map\\([^]*?\\):([^]*?)${query}\\?`))?.[0];
      assert.ok(recentPrefix && localPrefix);
      for (const pinned of [[], ['qa']]) {
        const emptyContext = { [recent]: [], [local]: [], [query]: true, codexPartition: { pinned } };
        const expected = pinned.length ? null : 'no-match';
        assert.equal(vm.runInNewContext(`${recentPrefix}"no-match":"empty":"recent"`, emptyContext), expected);
        assert.equal(vm.runInNewContext(`${localPrefix}"no-match":"empty"`, emptyContext), expected);
      }
      const pinnedAtom = old ? 'Dw' : modern ? 'Lw' : 'jw';
      const row = old ? 's4t' : modern ? 'YBn' : 'u4t';
      const plainRow = old ? 'pWt' : modern ? 'cPn' : 'gWt';
      const jsx = old ? 'VX' : modern ? 'Z2' : 'HX';
      const renderSource = app.slice(app.indexOf('function codexMultiTabHistoryRow('), app.lastIndexOf('export{codexMultiTabHistoryRow'));
      const context = {
        URLSearchParams, document: documentFor('/new?codexMultiTab=qa'),
        vo: atom => { assert.equal(atom, 'native-pins'); return ['pinned']; },
        o: atom => { assert.equal(atom, 'native-pins'); return ['pinned']; },
        [pinnedAtom]: 'native-pins', [row]: 'native-sidebar-row', [plainRow]: 'native-history-row',
        [jsx]: { jsx: (type, props) => ({ type, props }) },
      };
      vm.createContext(context);
      vm.runInContext(renderSource, context);
      const click = () => {};
      const enhanced = context.codexMultiTabHistoryRow({ conversationId: 'pinned', onClick: click });
      assert.equal(enhanced.type, 'native-sidebar-row');
      assert.equal(enhanced.props.isPinned, true);
      assert.equal(enhanced.props.onClick, click);
      assert.equal(enhanced.props.codexMultiTabHistory, true);
      context.document = documentFor('/local/ordinary');
      assert.equal(context.codexMultiTabHistoryRow({ conversationId: 'pinned' }).type, 'native-history-row');

      // 执行实际注入的菜单分支，验证只有原生改名和置顶回调。
      const menuStart = modern ? 'mt=e=>{if(codexHistory)' : 'et=e=>{if(codexHistory)';
      const start = app.indexOf(menuStart);
      assert.ok(start >= 0);
      const end = app.indexOf(';let t=', start);
      const menuSource = app.slice(start + 'et='.length, end) + ';}';
      const actions = [];
      const pinItem = old ? 'YY' : 'XY';
      const menu = old ? 'fX' : 'pX';
      const pin = old ? 'KH' : 'qH';
      const menuContext = {
        codexHistory: true, n: 'pinned', T: { get: () => ['pinned'] }, [pinnedAtom]: 'native-pins',
        [pinItem]: ({ isPinned, onPinnedChange }) => ({ id: isPinned ? 'unpin-thread' : 'pin-thread', onSelect: () => onPinnedChange(!isPinned) }),
        [menu]: ({ pin, rename }) => [rename, pin], He: () => actions.push('rename'),
        [pin]: (scope, id, value) => actions.push({ id, value }),
        E: { get: () => ['pinned'] },
        S2: ({ isPinned, onPinnedChange }) => ({ id: isPinned ? 'unpin-thread' : 'pin-thread', onSelect: () => onPinnedChange(!isPinned) }),
        N2: ({ pin, rename }) => [rename, pin], nt: () => actions.push('rename'),
        UB: (scope, id, value) => actions.push({ id, value }),
      };
      const items = vm.runInNewContext(`(${menuSource})()`, menuContext);
      assert.deepEqual(Array.from(items, item => item.id), ['rename-thread', 'unpin-thread']);
      items[0].onSelect();
      items[1].onSelect();
      assert.deepEqual(actions, ['rename', { id: 'pinned', value: false }]);
      if (modern) {
        assert.match(host, /this\.broadcastPersistedAtomUpdate\(se,ue\),se==="pinned-thread-ids"/);
        assert.ok(host.includes('})(this,qe,e,r))break;let n=hM(r.path);'));
        assert.match(header, /codexPins=n\(codexMultiTabPinnedIds\)/);
        assert.match(header, /t\[17\]!==F/);
        assert.match(header, /t\[26\]!==ae\|\|t\[27\]!==B/);
        assert.match(app, /getMenuItems:D\|\|codexHistory\?\(\)=>ht\(`row-actions`\)/);
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}

test('未知版本不输出猜测补丁', () => {
  assert.throws(() => getNativePatchFiles('future'), /尚未审计/);
});
