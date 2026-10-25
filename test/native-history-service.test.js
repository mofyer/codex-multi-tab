'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { getNativePatchFiles, getNativeDependencies, nativePinnedThreads, nativePinnedThreadService,
  navigateHistoryInPlace, partitionConversationHistory } = require('../src/compatibility/native-history-patch');

const VERSION = '26.1021.22027';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const documentFor = route => ({ querySelector: () => route == null ? null : { content: route } });

function stateFor(initial = []) {
  const records = { 'pinned-thread-ids': initial, unrelated: 'retain' };
  let queue = Promise.resolve();
  return {
    records,
    enqueueUpdate(key, callback) {
      assert.equal(key, 'codex-multi-tab-native-pin-operation');
      const operation = queue.catch(() => {}).then(callback);
      queue = operation;
      return operation;
    },
    async get(key) { assert.equal(key, 'persisted-atom-state'); return records; },
    async updatePersistedAtomValue(key, value) { records[key] = value; },
  };
}

test('pinnedThreads 服务按官方 RPC 形状读写同一 atom，排序请求明确失败', async () => {
  const state = stateFor(['first']);
  const service = nativePinnedThreadService(state, nativePinnedThreads);
  assert.deepEqual(await service.list(), { threadIds: ['first'] });
  assert.deepEqual(await service.list({ useAppServerPins: true }), { threadIds: ['first'] });
  assert.deepEqual(await service.set({ threadId: 'second', pinned: true, beforeThreadId: 'first' }), { success: true });
  assert.deepEqual(await service.set({ threadId: 'third', pinned: true, beforeThreadId: null }), { success: true });
  assert.deepEqual((await service.list()).threadIds, ['second', 'first', 'third']);
  await service.set({ threadId: 'first', pinned: false });
  assert.deepEqual(state.records, { 'pinned-thread-ids': ['second', 'third'], unrelated: 'retain' });
  // 缺参不得退化为读取并被当作写入成功。
  await assert.rejects(service.set(), /参数无效/);
  await assert.rejects(service.set({ threadId: '../x', pinned: true }), /参数无效/);
  assert.deepEqual(await service.setOrder({ threadIds: ['third', 'second'], movedThreadId: 'third' }), { success: false });
  assert.deepEqual(state.records['pinned-thread-ids'], ['second', 'third']);
});

test('按 conversationId 分组：保留云端、待启动和待建工作树行，按官方置顶顺序去重', () => {
  const conversation = id => ({ conversationId: id, hostId: 'local', updatedAt: 1 });
  const a = conversation('a'), b = conversation('b'), c = conversation('c');
  const items = [
    { kind: 'remote', key: 'remote', task: { id: 'a' } },
    { kind: 'local', key: 'starting', pendingThreadStart: { clientThreadId: 'a' }, conversation: a },
    { kind: 'local', key: 'worktree', conversation: null, pendingWorktree: { id: 'w' } },
    { kind: 'local', key: 'b', conversation: b },
  ];
  const result = partitionConversationHistory(items, [a, b, c], ['b', 'missing', 'a'], true);
  assert.deepEqual(result.pinned.map(item => item.conversation.conversationId), ['b', 'a']);
  assert.equal(result.pinned[0], items[3]);
  assert.deepEqual(result.pinned[1], { kind: 'local', key: 'codex-multi-tab-pin:a', conversation: a });
  assert.deepEqual(result.items.map(item => item.key), ['remote', 'starting', 'worktree']);
  assert.deepEqual(result.conversations, [c]);
  const ordinary = partitionConversationHistory(items, [a, b, c], ['a'], false);
  assert.equal(ordinary.items, items);
  assert.deepEqual(ordinary.pinned, []);
});

test('带 hostId 查询的历史路径也在当前辅助标签确认后切换', async () => {
  const panel = {}, sent = [];
  const host = {
    editorPanels: new Map([[panel, { initialRoute: '/new?codexMultiTab=qa' }]]),
    findPanelByWebview: () => panel, isPanelAlive: () => true,
    sendMessageToPanel: (target, message) => sent.push(message),
  };
  const vscode = { window: { showWarningMessage: async () => '继续切换' } };
  assert.equal(await navigateHistoryInPlace(host, vscode, 'webview', { path: '/local/thread-1?hostId=local' }), true);
  assert.deepEqual(sent, [{ type: 'navigate-to-route', path: '/local/thread-1?hostId=local' }]);
});

function installedRoot() {
  const override = process.env.CODEX_MULTI_TAB_OFFICIAL_ROOT;
  if (override && fs.existsSync(path.join(override, 'package.json'))
    && JSON.parse(fs.readFileSync(path.join(override, 'package.json'), 'utf8')).version === VERSION) return override;
  return path.join(os.homedir(), `.vscode/extensions/openai.chatgpt-${VERSION}-darwin-arm64`);
}

// 本机已应用增强时，从运行时备份或官方缓存安装包取经哈希核对的原件。
function readOriginal(root, entry) {
  const bytes = fs.readFileSync(path.join(root, entry.file));
  if (hash(bytes) === entry.originalHash) return bytes.toString('utf8');
  const backupRoot = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups');
  for (const directory of fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []) {
    const manifestFile = path.join(backupRoot, directory, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const saved = manifest.root === fs.realpathSync(root) ? manifest.files.find(file => file.file === entry.file) : undefined;
    const original = saved && fs.readFileSync(path.join(backupRoot, directory, saved.backup));
    if (original && hash(original) === entry.originalHash) return original.toString('utf8');
  }
  const cached = path.join(os.homedir(), 'Library/Application Support/Code/CachedExtensionVSIXs', `openai.chatgpt-${VERSION}-darwin-arm64`);
  if (fs.existsSync(cached)) {
    const result = spawnSync('unzip', ['-p', cached, `extension/${entry.file}`], { maxBuffer: 30 * 1024 * 1024 });
    if (result.status === 0 && hash(result.stdout) === entry.originalHash) return result.stdout.toString('utf8');
  }
  throw new Error(`找不到已校验原件：${entry.file}`);
}

// 按括号边界截取压缩包中的单个函数。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `缺少函数 ${name}`);
  let index = source.indexOf('{', start), depth = 0;
  do {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    index++;
  } while (depth > 0 && index < source.length);
  return source.slice(start, index);
}

function collect(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => collect(child, predicate, result));
  else if (tree && typeof tree === 'object') {
    if (predicate(tree)) result.push(tree);
    collect(tree.props?.children, predicate, result);
  }
  return result;
}

const root = installedRoot();
test(`${VERSION} 真实资产：置顶服务、增强行菜单、历史分组缓存与新聊天页范围`, { skip: !fs.existsSync(root) }, () => {
  for (const entry of getNativeDependencies(VERSION)) assert.equal(hash(fs.readFileSync(path.join(root, entry.file))), entry.originalHash, entry.file);
  // 依赖的官方菜单表按 id 提供置顶、取消置顶和重命名文案。
  const presentation = fs.readFileSync(path.join(root, 'webview/assets/sidebar-thread-action-presentation-cf3c882f4ace.js'), 'utf8');
  for (const id of ['"pin-thread":V.pin', '"unpin-thread":V.unpin', '"rename-thread":V.rename']) assert.ok(presentation.includes(id), id);
  const patches = getNativePatchFiles(VERSION);
  assert.deepEqual(patches.map(entry => entry.file), ['out/extension.js', 'webview/assets/pending-thread-start-row-107fd6c2d961.js',
    'webview/assets/header-e3d61ada3ae3.js', 'webview/assets/new-thread-panel-page-79b34ce3453f.js']);
  const [host, app, header, panel] = patches.map(entry => entry.transform(readOriginal(root, entry)));

  new vm.Script(host);
  assert.ok(host.includes(`new J1({pinnedThreads:(${nativePinnedThreadService.toString()})(this.globalState,(${nativePinnedThreads.toString()})),worktreeSnapshots:i,`));
  assert.ok(host.includes('this.broadcastPersistedAtomUpdate(X,ye),X==="pinned-thread-ids"&&this.broadcastToAllViews({type:"pinned-threads-updated"})'));
  assert.ok(host.includes('})(this,Be,e,r))break;let n=F1(r.path);if(!r.replaceCurrentEditor)'));
  for (const source of [app, header, panel]) {
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }

  // 增强行：菜单只在辅助历史中替换，按打开时的 atom 状态生成，并跳过桌面数据预加载。
  assert.ok(app.includes('setPendingWorktreePinned:E,threadSummary:D,codexMultiTabHistory:codexHistory,...ne}=e'));
  assert.ok(app.includes('tn=e=>{if(codexHistory)return codexMultiTabHistoryMenu(F,i,Vt);if(H)return['));
  assert.ok(app.includes('getMenuItems:codexHistory||an||H?()=>Z(`row-actions`):void 0'));
  assert.ok(app.includes('$t=async()=>{if(codexHistory)return;await Promise.all([yi(F),u?q(F):void 0])}'));
  const initialized = [], calls = [];
  const rowContext = {
    URLSearchParams, document: documentFor('/new?codexMultiTab=qa'), K: 'native-pins',
    ls: () => initialized.push('row'), ai: () => initialized.push('menu-presentation'), pt: () => initialized.push('pins'),
    N: atom => { assert.equal(atom, 'native-pins'); return ['first']; },
    Q: { jsx: (type, props) => ({ type, props }) }, rs: 'enhanced-native-row', Za: 'plain-native-row',
    oi: ({ pin, rename, ...rest }) => { assert.deepEqual(rest, {}); return [rename, pin]; },
    lr: (scope, threadId, pinned) => calls.push({ threadId, pinned }),
  };
  vm.createContext(rowContext);
  vm.runInContext(app.slice(app.indexOf('function codexMultiTabHistoryInit()'), app.lastIndexOf('export{codexMultiTabHistoryRow')), rowContext);
  rowContext.codexMultiTabHistoryInit();
  assert.deepEqual(initialized, ['row', 'menu-presentation', 'pins']);
  const onClick = () => {};
  const row = rowContext.codexMultiTabHistoryRow({ conversationId: 'first', hostId: 'local', onClick });
  assert.equal(row.type, 'enhanced-native-row');
  assert.equal(row.props.codexMultiTabHistory, true);
  assert.equal(row.props.isPinned, true);
  assert.equal(row.props.showPinActionOnHover, true);
  assert.equal(row.props.onClick, onClick);
  assert.equal(rowContext.codexMultiTabHistoryRow({ conversationId: 'other' }).props.isPinned, false);
  rowContext.document = documentFor('/local/ordinary');
  const plainProps = { conversationId: 'first' };
  const plain = rowContext.codexMultiTabHistoryRow(plainProps);
  assert.equal(plain.type, 'plain-native-row');
  assert.equal(plain.props, plainProps);
  let pins = ['first'];
  const scope = { get: atom => { assert.equal(atom, 'native-pins'); return pins; } };
  const renamed = [];
  let menu = rowContext.codexMultiTabHistoryMenu(scope, 'first', () => renamed.push('first'));
  assert.deepEqual(Array.from(menu, item => item.id), ['rename-thread', 'unpin-thread']);
  menu.forEach(item => item.onSelect());
  pins = [];
  menu = rowContext.codexMultiTabHistoryMenu(scope, 'first', () => {});
  assert.equal(menu[1].id, 'pin-thread');
  menu[1].onSelect();
  assert.deepEqual(renamed, ['first']);
  assert.deepEqual(calls, [{ threadId: 'first', pinned: false }, { threadId: 'first', pinned: true }]);

  // 历史列表：初始化与两种本地行都改用增强行包装，云端行保持官方组件。
  assert.ok(header.startsWith('import{codexMultiTabHistoryRow,codexMultiTabHistoryInit,codexMultiTabPinnedIds}from"./pending-thread-start-row-107fd6c2d961.js";\n'));
  assert.ok(header.includes('Nn=e((()=>{codexMultiTabHistoryInit(),kn=f(),'));
  assert.equal(header.split('(0,Z.jsx)(codexMultiTabHistoryRow,{').length, 3);
  assert.equal(header.split('(0,Z.jsx)(ot,').length, 1);

  // 执行转换后的官方 Cn 组件，保留 compiler cache 跨渲染。
  const cache = Array(38).fill(Symbol.for('react.memo_cache_sentinel'));
  const jsx = (type, props, key) => ({ type, props, key });
  const titles = new Map();
  let filter = 'local', active = 'first', query = '';
  const context = {
    URLSearchParams, document: documentFor('/new?codexMultiTab=qa'), codexMultiTabPinnedIds: 'pins', zt: 'filter', Bt: 'environment', Ot: 'titles', T: 'store',
    te: atom => atom === 'pins' ? pins : atom === 'filter' ? filter : null,
    kn: { c: size => { assert.equal(size, 38); return cache; } },
    b: () => ({ set() {} }), ee: () => ({}), Ke: () => 'archive-start', de: () => ({ authMethod: 'chatgpt' }),
    E: pattern => pattern === '/local/:conversationId' ? { params: { conversationId: active } } : null,
    Re: () => ({ data: [] }), Je: () => false, hn: () => true,
    _n: (tasks, conversations) => [...conversations.map(conversation => ({ kind: 'local', key: conversation.conversationId, conversation })), ...(tasks ?? [])],
    An: { useState: () => [query, () => {}], useDeferredValue: value => value },
    Tn: item => item.kind === 'remote', wn: item => ({ hostId: item.hostId, threadId: item.conversationId }),
    x: (atom, keys) => { assert.equal(atom, 'titles'); return keys.map(key => ({ ...key, title: titles.get(key.threadId) })); },
    ke: (title, text) => (title ?? '').toLowerCase().includes(text), En: () => 'worktree',
    Z: { jsx, jsxs: jsx, Fragment: 'Fragment' }, xe: { Section: 'Section' },
    Ht: 'Search', rn: 'Filter', Qt: 'Environment', On: 'Error', Dn: 'Loading', dn: 'NoMatch', Kt: 'Empty',
    ft: 'CloudRow', jn: 'LocalRow', Mn: 'RecentRow', v: 'Message', F: 'Button', re: 'Spinner',
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(header, 'Cn'), context);
  const first = { conversationId: 'first', hostId: 'local', updatedAt: 1 };
  const second = { conversationId: 'second', hostId: 'local', updatedAt: 2 };
  titles.set('first', 'First').set('second', 'Second');
  const props = { cloudtasksQuery: { data: [] }, localConversations: [first, second], onClose: () => {} };
  const section = tree => collect(tree, node => node.type === 'Section' && Array.isArray(node.props.children) && node.props.children.length === 4)[0];
  const pinnedRows = tree => collect(section(tree).props.children[0], node => node.type === 'RecentRow');
  pins = ['first', 'second'];
  let tree = context.Cn(props);
  assert.deepEqual(pinnedRows(tree).map(node => node.props.item.conversation.conversationId), ['first', 'second']);
  assert.equal(pinnedRows(tree)[0].props.isActive, true);
  assert.equal(pinnedRows(tree)[0].props.onActiveArchiveStart, 'archive-start');
  assert.equal(collect(tree, node => node.type === 'Empty').length, 0);
  assert.equal(collect(tree, node => node.type === 'LocalRow').length, 0);
  // 同一 pins 引用，但活动会话、会话元数据、关闭回调均已变化。
  active = 'second';
  const close = () => {};
  tree = context.Cn({ ...props, onClose: close, localConversations: [{ ...first, updatedAt: 5 }, second] });
  assert.equal(pinnedRows(tree)[0].props.item.conversation.updatedAt, 5);
  assert.equal(pinnedRows(tree)[0].props.isActive, false);
  assert.equal(pinnedRows(tree)[1].props.isActive, true);
  assert.equal(pinnedRows(tree)[0].props.onClose, close);
  pins = ['second'];
  tree = context.Cn(props);
  assert.deepEqual(pinnedRows(tree).map(node => node.props.item.conversation.conversationId), ['second']);
  assert.deepEqual(collect(tree, node => node.type === 'LocalRow').map(node => node.props.conversationId), ['first']);
  query = 'first';
  tree = context.Cn(props);
  assert.equal(section(tree).props.children[0], null);
  assert.equal(collect(tree, node => node.type === 'LocalRow').length, 1);
  query = 'second';
  tree = context.Cn(props);
  assert.equal(pinnedRows(tree).length, 1);
  assert.equal(collect(tree, node => node.type === 'NoMatch').length, 0);
  // 最近视图：云端、待启动行保留在原列表，全部本地会话置顶时不显示空状态。
  query = ''; filter = 'recent'; pins = ['first', 'second'];
  const remote = { kind: 'remote', key: 'remote-task', task: { id: 'task', title: 'Cloud' } };
  tree = context.Cn({ ...props, cloudtasksQuery: { data: [remote], isLoading: false, isError: false } });
  assert.deepEqual(pinnedRows(tree).map(node => node.key), ['first', 'second']);
  const recentRows = collect(section(tree).props.children[3], node => node.type === 'RecentRow');
  assert.deepEqual(recentRows.map(node => node.key), ['remote-task']);
  pins = ['first', 'second'];
  tree = context.Cn({ ...props, cloudtasksQuery: { data: [], isLoading: false, isError: false } });
  assert.equal(collect(tree, node => node.type === 'Empty').length, 0);
  filter = 'cloud';
  tree = context.Cn({ ...props, cloudtasksQuery: { data: [], isLoading: false, isError: false } });
  assert.equal(section(tree).props.children[0], null);
  context.document = documentFor('/local/ordinary'); filter = 'local';
  tree = context.Cn(props);
  assert.equal(section(tree).props.children[0], null);
  assert.equal(collect(tree, node => node.type === 'LocalRow').length, 2);

  const panelStart = panel.indexOf('children:[(') + 'children:['.length;
  const panelEnd = panel.indexOf(',f,C]', panelStart);
  assert.ok(panel.startsWith('import{Header as CodexMultiTabNativeHeader}from"./header-8d251301fd26.js";\n'));
  for (const [route, expected] of [['/new?codexMultiTab=qa', 'native-header'], ['/new', null]]) {
    const result = vm.runInNewContext(panel.slice(panelStart, panelEnd), { URLSearchParams, document: documentFor(route),
      F: { jsx }, CodexMultiTabNativeHeader: 'native-header' });
    assert.equal(result?.type ?? null, expected);
  }
});
