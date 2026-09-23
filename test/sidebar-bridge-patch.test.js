'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { registerSidebarBridge, reportSidebarRoute, transformSidebarHost, transformSidebarWebview } = require('../src/compatibility/sidebar-bridge-patch');
const { nativePinnedThreads } = require('../src/compatibility/native-history-patch');

function fixture(t, timeout = 1000, clock = Date) {
  const sent = [], abandoned = [], subscriptions = [];
  let callbacks, command, providerDisposed = false, commandDisposed = false;
  const store = { 'persisted-atom-state': { 'pinned-thread-ids': ['old'] } };
  let queue = Promise.resolve();
  const host = {
    editorPanels: new Map(),
    findPanelByWebview(view) { return [...this.editorPanels.keys()].find(panel => panel.webview === view); },
    isPanelAlive(panel) { return !panel.dead; },
    globalState: {
      enqueueUpdate(key, callback) { const next = queue.then(callback); queue = next.catch(() => {}); return next; },
      async get(key) { return store[key]; },
      async updatePersistedAtomValue(key, value) { store['persisted-atom-state'][key] = value; },
    },
    codexMcpConnection: {
      registerProvider(name, handlers) {
        assert.equal(name, 'codexMultiTab.sidebar'); callbacks = handlers;
        return { dispose() { providerDisposed = true; } };
      },
      sendRequest(provider, id, method, params) { sent.push({ provider, id, method, params }); },
      abandonRequest(provider, id) { abandoned.push({ provider, id }); },
    },
  };
  const vscode = { commands: { registerCommand(name, callback) {
    assert.equal(name, 'codexMultiTab.internalBridge'); command = callback;
    return { dispose() { commandDisposed = true; } };
  } } };
  // 实际注入以函数字符串运行，此处独立上下文验证无模块闭包依赖。
  const register = vm.runInNewContext(`(${registerSidebarBridge.toString()})`, { setTimeout, clearTimeout, URLSearchParams, Date: clock });
  const bridge = register(host, vscode, { subscriptions }, nativePinnedThreads, timeout);
  t.after(() => bridge.dispose());
  const call = request => command(request);
  return { host, bridge, call, sent, abandoned, subscriptions, callbacks, store,
    disposed: () => providerDisposed && commandDisposed,
    reply(result, index = sent.length - 1) { callbacks.onResult({ id: sent[index].id, result }); },
    panel(name) {
      let close;
      const panel = { webview: {}, viewColumn: 2, reveals: [],
        onDidDispose(callback) { close = callback; return { dispose() {} }; },
        reveal(...args) { this.reveals.push(args); },
        close() { this.dead = true; host.editorPanels.delete(this); close?.(); },
      };
      host.editorPanels.set(panel, { initialRoute: `/extension/panel/new?codexMultiTab=${name}` });
      return panel;
    },
  };
}

test('桥使用同官方 provider，精确匹配响应并保留原始结果', async t => {
  const f = fixture(t);
  assert.equal((await f.call({ action: 'status' })).version, 1);
  assert.equal(f.subscriptions[0], f.bridge);
  const account = f.call({ action: 'rpc', method: 'account/read', params: { refreshToken: true } });
  const list = f.call({ action: 'rpc', method: 'thread/list', params: { limit: 50 } });
  assert.equal(f.sent[0].params.refreshToken, false);
  assert.equal(f.sent[1].params.useStateDbOnly, true);
  const rows = { data: [{ id: 'synthetic-thread', name: '测试会话' }], nextCursor: null };
  f.reply(rows, 1);
  assert.equal(await list, rows);
  f.reply({ account: null, requiresOpenaiAuth: true }, 0);
  assert.equal((await account).account, null);
  const read = f.call({ action: 'rpc', method: 'thread/read', params: { threadId: 'synthetic-thread', includeTurns: true } });
  assert.equal(f.sent[2].params.includeTurns, false);
  f.reply({ thread: { id: 'synthetic-thread' } });
  await read;
});

test('白名单拒绝模型执行、令牌读取、任意方法与无效重置参数，均不发送', async t => {
  const f = fixture(t);
  for (const method of ['turn/start', 'thread/start', 'thread/resume', 'account/logout', 'getAuthStatus', 'fetch', '__proto__']) {
    await assert.rejects(f.call({ action: 'rpc', method, params: {} }), { code: 'CODEX_MULTI_TAB_UNSUPPORTED_METHOD' });
  }
  for (const request of [
    { method: 'account/read', params: { includeToken: true } },
    { method: 'thread/read', params: { threadId: '../bad' } },
    { method: 'thread/name/set', params: { threadId: 'a', name: ' ' } },
    { method: 'thread/search', params: { searchTerm: '' } },
    { method: 'thread/list', params: { limit: 5000 } },
    { method: 'account/rateLimits/read', params: { unknown: true } },
    { method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey: 'test' } },
    { method: 'account/rateLimitResetCredit/consume', params: { creditId: 'synthetic', redeemRequestId: 'test' } },
  ]) await assert.rejects(f.call({ action: 'rpc', ...request }), { code: 'CODEX_MULTI_TAB_INVALID_REQUEST' });
  assert.equal(f.sent.length, 0);
});

test('额度详情和重置遵循实际 binary schema；仅向替身发请求，不消费真实卡', async t => {
  const f = fixture(t);
  const usage = f.call({ action: 'rpc', method: 'account/rateLimits/read', params: { excludeResetCreditDetails: false } });
  const payload = { rateLimits: { primary: { usedPercent: 100, resetsAt: 1800000000 } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'synthetic-credit', title: '测试重置卡',
      expiresAt: 1800000000, grantedAt: 1700000000, status: 'available', resetType: 'codexRateLimits' }] } };
  f.reply(payload);
  assert.equal(await usage, payload);
  const params = { creditId: 'synthetic-credit', idempotencyKey: 'f6c17e96-6d23-4d95-ae64-425f670261a3' };
  for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
    const response = f.call({ action: 'rpc', method: 'account/rateLimitResetCredit/consume', params });
    assert.equal(f.sent.at(-1).params.idempotencyKey, params.idempotencyKey);
    assert.equal(f.sent.at(-1).params.creditId, params.creditId);
    f.reply({ outcome });
    assert.equal((await response).outcome, outcome);
  }
});

test('失败不包含敏感响应，超时和关闭均清理 pending/provider/命令', async t => {
  const f = fixture(t, 10);
  const request = f.call({ action: 'rpc', method: 'account/read' });
  f.callbacks.onResult({ id: f.sent[0].id, error: { message: 'sensitive-token-body' } });
  await assert.rejects(request, error => error.code === 'CODEX_MULTI_TAB_RPC_FAILED' && !error.message.includes('sensitive'));
  const timeout = f.call({ action: 'rpc', method: 'account/read' });
  await assert.rejects(timeout, { code: 'CODEX_MULTI_TAB_RPC_TIMEOUT' });
  assert.equal(f.abandoned.length, 1);
  f.reply({ ignoredLateResponse: true });
  const closing = f.call({ action: 'rpc', method: 'account/read' });
  f.bridge.dispose();
  await assert.rejects(closing, { code: 'CODEX_MULTI_TAB_DISPOSED' });
  assert.equal(f.disposed(), true);
  assert.equal(f.abandoned.length, 2);
  assert.equal(f.host.codexMultiTabSidebarBridge, undefined);
  await assert.rejects(f.call({ action: 'status' }), { code: 'CODEX_MULTI_TAB_DISPOSED' });
});

test('置顶直接读写官方 atom；路由按 sender 区分空白、首条会话、切换、关闭和 reveal', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.call({ action: 'pins' }), { threadIds: ['old'] });
  await f.call({ action: 'pins', input: { threadId: 'second', pinned: true } });
  assert.deepEqual(f.store['persisted-atom-state']['pinned-thread-ids'], ['old', 'second']);
  const a = f.panel('a'), b = f.panel('b');
  // 初始 URI 仍指向 new，只有当前 sender 的已提交路由决定归属。
  f.bridge.trackRoute(a.webview, '/extension/panel/new');
  f.bridge.trackRoute(b.webview, '/local/b');
  f.bridge.trackRoute({}, '/local/sidebar-does-not-count');
  assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), ['b']);
  f.bridge.trackRoute(a.webview, '/local/a');
  assert.equal((await f.call({ action: 'reveal', threadId: 'a' })).revealed, true);
  assert.deepEqual(a.reveals, [[2, false]]);
  assert.equal(b.reveals.length, 0);
  f.bridge.trackRoute(a.webview, '/local/c');
  assert.equal((await f.call({ action: 'reveal', threadId: 'a' })).revealed, false);
  assert.equal((await f.call({ action: 'reveal', threadId: 'c' })).revealed, true);
  f.bridge.trackRoute(a.webview, '/settings');
  assert.equal((await f.call({ action: 'reveal', threadId: 'c' })).revealed, false);
  b.close();
  assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), []);
  f.bridge.trackRoute(b.webview, '/local/b');
  assert.equal((await f.call({ action: 'reveal', threadId: 'b' })).revealed, false);
});

test('历史标签已创建尚未上报时可立即 reveal；首次真实路由后绝不回退初始目标', async t => {
  const f = fixture(t);
  const panel = f.panel('opening');
  f.host.editorPanels.get(panel).initialRoute = '/local/target?codexMultiTab=opening';
  assert.equal((await f.call({ action: 'reveal', threadId: 'target' })).revealed, true);
  assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), ['target']);
  assert.deepEqual(panel.reveals, [[2, false]]);
  f.bridge.trackRoute(panel.webview, '/extension/panel/new');
  assert.equal((await f.call({ action: 'reveal', threadId: 'target' })).revealed, false);
  assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), []);
  f.bridge.trackRoute(panel.webview, '/local/current');
  assert.equal((await f.call({ action: 'reveal', threadId: 'target' })).revealed, false);
  assert.equal((await f.call({ action: 'reveal', threadId: 'current' })).revealed, true);
  panel.close();
  assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), []);
  // 不带辅助标记或带空标记的原始 URI 不作为未经路由提交的预报。
  for (const route of ['/local/plain', '/local/empty?codexMultiTab=', '/local/unsafe?codexMultiTab=a#fragment']) {
    const other = f.panel('other');
    f.host.editorPanels.get(other).initialRoute = route;
    assert.deepEqual(Array.from((await f.call({ action: 'panels' })).threadIds), []);
    other.close();
  }
  // 第一次枚举之前已有真实空白路由，也不得用 initialRoute 将会话重新标为已打开。
  const reported = f.panel('reported');
  f.host.editorPanels.get(reported).initialRoute = '/local/old?codexMultiTab=reported';
  f.bridge.trackRoute(reported.webview, '/extension/panel/new');
  assert.equal((await f.call({ action: 'reveal', threadId: 'old' })).revealed, false);
});

test('真实 useLocation 包装只在 layout effect 提交后发送；丢弃渲染不改映射、不再 acquire API', () => {
  for (const [version, exported, alias, api] of [
    ['26.5908.31748', 'xW', 'Qo', 'qf'],
    ['26.908.40401', 'xW', 'Zo', 'Jf'],
    ['26.917.61114', 'RZ', 'Hr', 'hp'],
  ]) {
    const source = transformSidebarWebview(`import{${exported} as ${alias},x as other}from"fixture";`, version);
    assert.equal(source.includes('acquireVsCodeApi'), false);
    const effects = [], messages = [], document = {};
    let location = { pathname: '/extension/panel/new' };
    const hook = vm.runInNewContext(`${source.slice(source.indexOf('\nfunction'))};${alias}`, {
      codexMultiTabOriginalLocation: () => location,
      q: () => ({ useLayoutEffect(effect) { effects.push(effect); } }),
      [api]: { postMessage(message) { messages.push(message); } }, document,
    });
    assert.equal(hook(), location);
    assert.equal(messages.length, 0);
    effects.shift()();
    assert.equal(messages[0].pathname, '/extension/panel/new');
    location = { pathname: '/local/discarded' };
    hook(); effects.length = 0;
    assert.equal(messages.length, 1);
    location = { pathname: '/local/created' };
    hook(); effects.shift()();
    assert.equal(messages[1].pathname, '/local/created');
    hook(); effects.shift()();
    assert.equal(messages.length, 2);
    location = { pathname: '/local/switched' };
    hook(); effects.shift()();
    assert.equal(messages.at(-1).pathname, '/local/switched');
  }
});

test('缺失/重复锚点必须拒绝，不碰未知官方资产', () => {
  assert.throws(() => transformSidebarHost('unknown'), /特征/);
  assert.throws(() => transformSidebarWebview('unknown', '26.5908.31748'), /特征/);
  assert.throws(() => transformSidebarWebview('xW as Qo,'.repeat(2), '26.5908.31748'), /特征/);
  assert.throws(() => transformSidebarWebview('', 'unknown'), /尚未审计/);
  const messages = [];
  reportSidebarRoute({ postMessage: message => messages.push(message) }, '/local/a', {});
  assert.equal(messages[0].type, 'codex-multi-tab-route');
});

// 临时目录已有两份经审计 bundle；安装包有完整恢复测试，离线副本补齐另一个 profile 的变换检查。
for (const [version, asset] of [['26.5908.31748', 'app-initial-972655adec02.js'], ['26.908.40401', 'app-initial-a190b16fc630.js']]) {
  const app = `/tmp/native-${version}-webview-assets-${asset}`;
  const host = `/tmp/native-${version}-out-extension.js`;
  test(`真实 ${version} 缓存副本：宿主和路由 hook 变换后语法正确`, { skip: !fs.existsSync(app) || !fs.existsSync(host) }, () => {
    const patchedHost = transformSidebarHost(fs.readFileSync(host, 'utf8'));
    const patchedWeb = transformSidebarWebview(fs.readFileSync(app, 'utf8'), version);
    new vm.Script(patchedHost);
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patchedWeb, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  });
}

const currentOfficialVsix = path.join(os.homedir(), 'Library/Application Support/Code/CachedExtensionVSIXs/openai.chatgpt-26.917.61114-darwin-arm64');
const currentOfficialRoot = path.join(os.homedir(), '.vscode/extensions/openai.chatgpt-26.917.61114-darwin-arm64');
test('真实 26.917 资产：侧栏宿主与路由 hook 变换后保持语法正确', {
  skip: !fs.existsSync(currentOfficialVsix) && !fs.existsSync(path.join(currentOfficialRoot, 'out/extension.js')),
}, () => {
  const original = (file, expectedHash) => {
    let bytes;
    if (fs.existsSync(currentOfficialVsix)) {
      const result = spawnSync('unzip', ['-p', currentOfficialVsix, `extension/${file}`], { maxBuffer: 30 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr?.toString());
      bytes = result.stdout;
    } else {
      bytes = fs.readFileSync(path.join(currentOfficialRoot, file));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
        const identity = crypto.createHash('sha256').update(fs.realpathSync(currentOfficialRoot)).digest('hex').slice(0, 16);
        const backup = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups', `26.917.61114-${identity}`);
        const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
        const entry = manifest.files.find(item => item.file === file);
        assert.equal(entry?.originalHash, expectedHash);
        bytes = fs.readFileSync(path.join(backup, entry.backup));
      }
    }
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expectedHash);
    return bytes.toString('utf8');
  };
  const host = transformSidebarHost(original('out/extension.js', '2ac22107521c9e8fd1c907bc335bd3b0609c8d612bb2731e8bed6badda5d6f13'), '26.917.61114');
  const webview = transformSidebarWebview(original('webview/assets/app-initial-801a1845d914.js', 'd9cbca4f44d7206d83bcd136f12400282e51cbae2cc8a147cb8b2412faa71eb4'), '26.917.61114');
  new vm.Script(host);
  const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: webview, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(webview, /RZ as codexMultiTabOriginalLocation/);
  assert.match(webview, /function Hr\(\)\{const location=codexMultiTabOriginalLocation\(\)/);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
async function seedRunning(f, id = 'one', turnId = 'turn-one') {
  const result = f.call({ action: 'runtime', threadIds: [id] });
  f.reply({ thread: { id, status: { type: 'active' } } });
  await flush();
  assert.equal(f.sent.at(-1).method, 'thread/turns/list');
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1).params)), { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  f.reply({ data: [{ id: turnId, status: 'inProgress', items: [] }] });
  return result;
}

test('运行状态只补读无正文元数据，后续通知更新且只返回请求的会话', async t => {
  const f = fixture(t);
  const initial = await seedRunning(f);
  assert.equal(initial.threads[0].isRunning, true);
  assert.equal(initial.threads[0].runningTurnId, 'turn-one');
  const count = f.sent.length;
  await f.call({ action: 'runtime', threadIds: ['one'] });
  assert.equal(f.sent.length, count);
  f.callbacks.onNotification({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'turn-two', status: 'inProgress', items: ['secret-body'] } } });
  f.callbacks.onNotification({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'turn-one', status: 'completed' } } });
  const updated = await f.call({ action: 'runtime', threadIds: ['one'] });
  assert.equal(updated.threads[0].runningTurnId, 'turn-two');
  assert.equal(JSON.stringify(updated).includes('secret-body'), false);
  assert.equal((await f.call({ action: 'runtime', threadIds: [] })).threads.length, 0);
  f.callbacks.onNotification({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'turn-two', status: 'interrupted' } } });
  assert.equal((await f.call({ action: 'runtime', threadIds: ['one'] })).threads[0].isRunning, false);
});

test('迟到运行快照不能覆盖新通知，未知官方状态不伪造空闲或可停止', async t => {
  const f = fixture(t);
  const pending = f.call({ action: 'runtime', threadIds: ['one'] });
  f.callbacks.onNotification({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'new', status: 'inProgress' } } });
  f.reply({ thread: { id: 'one', status: { type: 'idle' } } });
  assert.equal((await pending).threads[0].runningTurnId, 'new');
  const unknown = f.call({ action: 'runtime', threadIds: ['unknown'] });
  f.reply({ thread: { id: 'unknown', status: { type: 'future-status' } } });
  assert.equal((await unknown).threads[0].isRunning, undefined);
  assert.equal((await f.call({ action: 'prepareStop', threadId: 'unknown', turnId: 'x' })).token, null);
});

test('Stop核验当前轮次并只发送一次精确中断，不以响应成功伪造已结束', async t => {
  const f = fixture(t); await seedRunning(f);
  const preparing = f.call({ action: 'prepareStop', threadId: 'one', turnId: 'turn-one' });
  assert.equal((await f.call({ action: 'prepareStop', threadId: 'one', turnId: 'turn-one' })).token, null);
  f.reply({ thread: { id: 'one', status: { type: 'active' } } }); await flush();
  f.reply({ data: [{ id: 'turn-one', status: 'inProgress' }] });
  const {token}=await preparing;
  const stopping=f.call({action:'stop',threadId:'one',turnId:'turn-one',token});
  assert.equal((await f.call({action:'stop',threadId:'one',turnId:'turn-one',token})).interrupted,false);
  assert.equal(f.sent.at(-1).method, 'turn/interrupt');
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1).params)), { threadId: 'one', turnId: 'turn-one' });
  f.reply({}); assert.equal((await stopping).interrupted, true);
  assert.equal((await f.call({ action: 'runtime', threadIds: ['one'] })).threads[0].isRunning, true);
  assert.equal(f.sent.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Stop复查期间任务结束或切换轮次时不发送中断', async t => {
  for (const next of [{ id: 'turn-two', status: 'inProgress' }, { id: 'turn-one', status: 'completed' }]) {
    const f = fixture(t); await seedRunning(f);
    const preparing = f.call({ action: 'prepareStop', threadId: 'one', turnId: 'turn-one' });
    f.reply({ thread: { id: 'one', status: { type: 'active' } } }); await flush();
    f.reply({ data: [next] });
    assert.equal((await preparing).token, null);
    assert.equal(f.sent.some(call => call.method === 'turn/interrupt'), false);
  }
});

test('运行状态参数及原始中断转发拒绝，连接终止后不复用旧可停状态', async t => {
  const f = fixture(t); await seedRunning(f);
  for (const request of [
    { action: 'runtime', threadIds: ['../invalid'] }, { action: 'runtime', threadIds: Array(201).fill('one') },
    { action: 'stop', threadId: 'one', turnId: '' },
  ]) await assert.rejects(f.call(request), { code: 'CODEX_MULTI_TAB_INVALID_REQUEST' });
  for (const method of ['turn/interrupt', 'thread/turns/list']) await assert.rejects(f.call({ action: 'rpc', method, params: { threadId: 'one', turnId: 'turn-one' } }), { code: 'CODEX_MULTI_TAB_UNSUPPORTED_METHOD' });
  f.callbacks.onFatalError();
  assert.equal((await f.call({ action: 'prepareStop', threadId: 'one', turnId: 'turn-one' })).token, null);
});

async function prepareTicket(f) {
  const request = f.call({ action: 'prepareStop', threadId: 'one', turnId: 'turn-one' });
  f.reply({ thread: { id: 'one', status: { type: 'active' } } }); await flush();
  f.reply({ data: [{ id: 'turn-one', status: 'inProgress' }] });
  return (await request).token;
}

test('停止票据绑定会话和轮次，过期、重用或准备后换轮均不得发送', async t => {
  let now = 1000;
  const f = fixture(t, 1000, { now: () => now }); await seedRunning(f);
  const token = await prepareTicket(f);
  for (const request of [
    { threadId: 'other', turnId: 'turn-one', token },
    { threadId: 'one', turnId: 'other', token },
    { threadId: 'one', turnId: 'turn-one', token: 'wrong' },
  ]) assert.equal((await f.call({ action: 'stop', ...request })).interrupted, false);
  now += 30001;
  assert.equal((await f.call({ action: 'stop', threadId: 'one', turnId: 'turn-one', token })).interrupted, false);
  const next = await prepareTicket(f);
  f.callbacks.onNotification({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'new-turn', status: 'inProgress' } } });
  assert.equal((await f.call({ action: 'stop', threadId: 'one', turnId: 'turn-one', token: next })).interrupted, false);
  f.callbacks.onNotification({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'turn-one', status: 'inProgress' } } });
  assert.equal((await f.call({ action: 'stop', threadId: 'one', turnId: 'turn-one', token: next })).interrupted, false);
  assert.equal(f.sent.some(call => call.method === 'turn/interrupt'), false);
});
