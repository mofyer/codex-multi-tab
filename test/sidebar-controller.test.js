'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSidebarController, normalizeLimits, isWorkspacePath } = require('../sidebar-controller');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const thread = (id, name = id, cwd = '/project') => ({ id, name, preview: '', updatedAt: 100, cwd });
const tick = () => new Promise(resolve => setImmediate(resolve));
const limits = (credits = []) => ({ accountId: 'test-account', rateLimits: { primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1800000000 } }, rateLimitResetCredits: { availableCount: credits.length, credits } });
const card = { id: 'test-card', title: '测试卡', status: 'available', resetType: 'codexRateLimits', expiresAt: 4000000000 };

/** 虚拟时钟只推进回调，不等待仍在网络中的请求，保留慢请求竞态。 */
function fakeTimers() {
  let now = 0, unrefs = 0;
  const entries = new Map();
  return {
    setInterval(callback, interval) {
      const handle = { unref() { unrefs++; } };
      entries.set(handle, { callback, interval, next: now + interval }); return handle;
    },
    clearInterval(handle) { entries.delete(handle); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const entry = [...entries.values()].sort((a, b) => a.next - b.next)[0];
        if (!entry || entry.next > target) break;
        now = entry.next; entry.next += entry.interval; entry.callback(); await tick();
      }
      now = target;
    },
    size: () => entries.size, unrefs: () => unrefs,
  };
}

/** 所有账号和卡均为协议替身，禁止测试消费真实卡。 */
function setup({ rpc: customRpc, bridge: customBridge, choice = '消耗重置卡并重置', commands = true, warning, open, input, folders = ['/project'], timers, runtime = false } = {}) {
  const calls = [], states = [], notices = [], errors = [], opens = [];
  let workspaceListener, workspaceDisposed = false;
  const makeFolders = values => values.map(value => typeof value === 'string' ? { uri: { scheme: 'file', fsPath: value } } : value);
  const vscode = {
    workspace: {
      workspaceFolders: makeFolders(folders),
      onDidChangeWorkspaceFolders(listener) { workspaceListener = listener; return { dispose() { workspaceDisposed = true; } }; },
    },
    extensions: { getExtension: () => ({ activate: async () => undefined }) },
    commands: {
      getCommands: async () => (typeof commands === 'function' ? commands() : commands) ? ['codexMultiTab.internalBridge'] : [],
      executeCommand: async (_command, request) => {
        calls.push(request);
        if (customBridge) { const value = customBridge(request); if (value !== undefined) return value; }
        if (request.action === 'status') return { version: 1, ...(runtime ? { capabilities: { runtime: true, stop: true } } : {}) };
        if (request.action === 'runtime') return { supported: true, threads: request.threadIds.map(threadId => ({ threadId, isRunning: true, runningTurnId: 'turn-current' })) };
        if (request.action === 'prepareStop') return { token: 'test-stop-ticket' };
        if (request.action === 'stop') return { interrupted: true };
        if (request.action === 'pins' || request.action === 'panels') return { threadIds: [] };
        if (request.action === 'reveal') return { revealed: false };
        if (request.action !== 'rpc') throw new Error('unsupported');
        if (customRpc) { const value = customRpc(request.method, request.params); if (value !== undefined) return value; }
        if (request.method === 'account/read') return { account: { type: 'chatgpt', email: 'demo@example.test', planType: 'pro' } };
        if (request.method === 'account/rateLimits/read') return limits([card]);
        if (request.method === 'thread/list') return { data: [thread('one')], nextCursor: null };
        if (request.method === 'thread/search') return { data: [{ thread: thread('found'), snippet: 'test' }], nextCursor: null };
        if (request.method === 'thread/read') return { thread: thread(request.params.threadId) };
        if (request.method === 'thread/name/set') return {};
        if (request.method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
        throw new Error('unhandled');
      },
    },
    window: {
      showWarningMessage: warning || (async () => choice),
      showInformationMessage: async value => { notices.push(value); },
      showErrorMessage: async value => { errors.push(value); },
      showInputBox: input || (async () => '新的名称'),
    },
  };
  const controller = createSidebarController(vscode, {}, {
    timers,
    postState: state => states.push(state), openNewTab: async () => opens.push('new'),
    openThreadTab: async id => { opens.push(id); if (open) await open(id); },
  });
  return { ...controller, calls, states, notices, errors, opens, state: () => states.at(-1),
    changeWorkspace(values) { vscode.workspace.workspaceFolders = makeFolders(values); return workspaceDisposed ? undefined : workspaceListener(); },
    workspaceDisposed: () => workspaceDisposed,
  };
}

test('真实字段归一化：多窗口、未知卡详情、重置时间不当套餐到期', () => {
  const actual = normalizeLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1234 }, secondary: { usedPercent: 82, windowDurationMins: 10080 } } }, rateLimitResetCredits: { availableCount: 1, credits: null } });
  assert.equal(actual.usage.windows.length, 2);
  assert.equal(actual.usage.windows[0].resetsAt, 1234);
  assert.equal(actual.credits.status, 'unavailable');
  assert.equal(actual.credits.availableCount, 1);
  assert.equal(normalizeLimits({}).usage.status, 'unavailable');
});

test('重置卡总数保留官方汇总，不被详情数量或折叠截断；未知总数不伪造零', () => {
  assert.equal(normalizeLimits({ rateLimitResetCredits: { availableCount: 7, credits: [card] } }).credits.availableCount, 7);
  assert.equal(normalizeLimits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }).credits.availableCount, 0);
  for (const count of [undefined, -1, 1.5, '3']) {
    assert.equal(normalizeLimits({ rateLimitResetCredits: { availableCount: count, credits: null } }).credits.availableCount, undefined);
  }
});

test('正常加载账号、官方额度和历史；非法消息不触发副作用', async () => {
  const app = setup(); await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().account.email, 'demo@example.test');
  assert.equal(app.state().usage.windows[0].usedPercent, 45);
  assert.equal(app.state().threads.items[0].id, 'one');
  const count = app.calls.length;
  await app.handleMessage({ type: 'rpc', method: 'turn/start' });
  await app.handleMessage({ type: 'openThread', threadId: '../../bad' });
  assert.equal(app.calls.length, count);
});

test('无桥显示兼容提示但新建入口仍可用', async () => {
  const app = setup({ commands: false }); await app.handleMessage({ type: 'ready' });
  assert.match(app.state().error, /兼容/);
  assert.equal(app.state().capabilities.reset, false);
  await app.handleMessage({ type: 'newTab' }); assert.deepEqual(app.opens, ['new']);
});

test('用量接口失败不影响账号和会话，也不显示虚假0', async () => {
  const app = setup({ rpc: method => { if (method === 'account/rateLimits/read') return Promise.reject(new Error('private-secret')); } });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().usage.status, 'unavailable');
  assert.equal(app.state().threads.items.length, 1);
  assert.ok(!JSON.stringify(app.states).includes('private-secret'));
});

test('过滤为空的分页自动继续；服务端分页和搜索响应正确解包', async () => {
  const app = setup({ rpc: (method, params) => {
    if (method === 'thread/list') return params.cursor ? { data: [thread('two')], nextCursor: null } : { data: [], nextCursor: 'next' };
  } });
  await app.handleMessage({ type: 'ready' }); assert.equal(app.state().threads.items[0].id, 'two');
  assert.equal(app.state().threads.hasMore, false);
  await app.handleMessage({ type: 'search', query: 'needle' }); assert.equal(app.state().threads.items[0].id, 'found');
  assert.ok(app.calls.some(call => call.method === 'thread/search' && call.params.searchTerm === 'needle'));
});

test('迟到的旧搜索不能覆盖新查询', async () => {
  const old = defer();
  const app = setup({ rpc: (method, params) => { if (method === 'thread/search' && params.searchTerm === 'old') return old.promise; } });
  await app.handleMessage({ type: 'ready' });
  const first = app.handleMessage({ type: 'search', query: 'old' });
  await tick();
  assert.ok(app.calls.some(call => call.params?.searchTerm === 'old'));
  await app.handleMessage({ type: 'search', query: 'new' });
  old.resolve({ data: [{ thread: thread('old-result') }], nextCursor: null }); await first;
  assert.equal(app.state().threads.items[0].id, 'found');
  assert.equal(app.state().threads.query, 'new');
});

test('置顶不在第一页仍读取摘要，不请求会话正文', async () => {
  const app = setup({ bridge: request => request.action === 'pins' ? { threadIds: ['older'] } : undefined,
    rpc: (method, params) => { if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: thread('older') }; } } });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().threads.items[0].id, 'older');
  assert.equal(app.state().threads.items[0].isPinned, true);
});

test('会话已开仅reveal，未开并发点击合并一次', async () => {
  const existing = setup({ bridge: request => request.action === 'reveal' ? { revealed: true } : undefined });
  await existing.handleMessage({ type: 'ready' }); await existing.handleMessage({ type: 'openThread', threadId: 'one' });
  assert.deepEqual(existing.opens, []);
  const gate = defer(); const app = setup({ open: () => gate.promise }); await app.handleMessage({ type: 'ready' });
  const a = app.handleMessage({ type: 'openThread', threadId: 'one' });
  const b = app.handleMessage({ type: 'openThread', threadId: 'one' });
  gate.resolve(); await Promise.all([a, b]); assert.deepEqual(app.opens, ['one']);
});

test('重命名调用官方名称接口', async () => {
  const app = setup(); await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'renameThread', threadId: 'one' });
  assert.ok(app.calls.some(call => call.method === 'thread/name/set' && call.params.name === '新的名称'));
});

test('重置卡到期边界不可消费，未知resetType不可消费', () => {
  const result = normalizeLimits(limits([{ ...card, expiresAt: 100 }, { ...card, id: 'unknown', resetType: 'unknown' }]), 100);
  assert.deepEqual(result.credits.items.map(item => item.available), [false, false]);
});

test('取消确认零消费；并发点击只产生一次真实消费请求并带幂等key', async () => {
  const cancelled = setup({ choice: undefined }); await cancelled.handleMessage({ type: 'ready' });
  // 显式覆盖默认参数的确认结果。
  const cancelApp = setup({ warning: async () => undefined }); await cancelApp.handleMessage({ type: 'ready' });
  await cancelApp.handleMessage({ type: 'resetCredit', creditId: card.id });
  assert.equal(cancelApp.calls.filter(call => call.method?.endsWith('/consume')).length, 0);
  const confirmation = defer(); const app = setup({ warning: () => confirmation.promise }); await app.handleMessage({ type: 'ready' });
  const first = app.handleMessage({ type: 'resetCredit', creditId: card.id });
  const second = app.handleMessage({ type: 'resetCredit', creditId: card.id });
  confirmation.resolve('消耗重置卡并重置'); await Promise.all([first, second]);
  const consumed = app.calls.filter(call => call.method?.endsWith('/consume'));
  assert.equal(consumed.length, 1); assert.match(consumed[0].params.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(consumed[0].params.creditId, card.id);
  assert.equal(app.state().credits.busyId, undefined);
});

test('确认期间卡失效，消费前再次检查', async () => {
  let reads = 0;
  const app = setup({ rpc: method => { if (method === 'account/rateLimits/read') return limits(++reads >= 3 ? [] : [card]); } });
  await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'resetCredit', creditId: card.id });
  assert.equal(app.calls.filter(call => call.method?.endsWith('/consume')).length, 0);
});

test('消费请求超时不自动重试，不显示重置成功', async () => {
  const app = setup({ rpc: method => { if (method.endsWith('/consume')) return Promise.reject(new Error('timeout')); } });
  await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'resetCredit', creditId: card.id });
  assert.equal(app.calls.filter(call => call.method?.endsWith('/consume')).length, 1);
  assert.ok(app.errors.some(value => value.includes('不会自动重复消费')));
  assert.equal(app.notices.some(value => value.includes('已完成')), false);
});

test('销毁后不发布迟到状态或在确认后消费', async () => {
  const confirmation = defer(); const app = setup({ warning: () => confirmation.promise });
  await app.handleMessage({ type: 'ready' });
  const pending = app.handleMessage({ type: 'resetCredit', creditId: card.id });
  await Promise.resolve(); app.dispose(); const count = app.states.length;
  confirmation.resolve('消耗重置卡并重置'); await pending;
  assert.equal(app.states.length, count);
  assert.equal(app.calls.filter(call => call.method?.endsWith('/consume')).length, 0);
});

test('新搜索失败也不残留可操作的旧会话', async () => {
  const app = setup({ rpc: method => { if (method === 'thread/search') return Promise.reject(new Error('offline')); } });
  await app.handleMessage({ type: 'ready' });
  await app.handleMessage({ type: 'search', query: 'different' });
  assert.equal(app.state().threads.query, 'different'); assert.deepEqual(app.state().threads.items, []);
  await app.handleMessage({ type: 'openThread', threadId: 'one' }); assert.deepEqual(app.opens, []);
});

test('置顶接口失败只禁用置顶，保留真实会话列表', async () => {
  const app = setup({ bridge: request => request.action === 'pins' ? Promise.reject(new Error('unavailable')) : undefined });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().threads.items[0].id, 'one'); assert.equal(app.state().capabilities.pin, false);
});

test('无accountId时用官方账号核对；确认期间换账号不得消费', async () => {
  let reads = 0;
  const app = setup({ rpc: method => {
    if (method === 'account/rateLimits/read') return { ...limits([card]), accountId: null };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: ++reads >= 3 ? 'changed@example.test' : 'demo@example.test' } };
  } });
  await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'resetCredit', creditId: card.id });
  assert.equal(app.calls.filter(call => call.method?.endsWith('/consume')).length, 0);
  assert.ok(app.notices.some(value => value.includes('账号或重置卡状态已变化')));
});

test('无法确认账号身份时不弹消费确认、不消费', async () => {
  let confirmations = 0;
  const app = setup({ warning: async () => { confirmations++; return '消耗重置卡并重置'; }, rpc: method => {
    if (method === 'account/rateLimits/read') return { ...limits([card]), accountId: null };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: null } };
  } });
  await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'resetCredit', creditId: card.id });
  assert.equal(confirmations, 0); assert.equal(app.calls.filter(call => call.method?.endsWith('/consume')).length, 0);
});

test('目录边界支持多根、子目录、Windows 大小写；拒绝相邻前缀和相对路径', () => {
  for (const cwd of ['/project', '/project/sub', '/project/a/../b', '/second/sub']) assert.equal(isWorkspacePath(cwd, ['/project', '/second']), true);
  for (const cwd of ['/project-other', '/project/../other', '/Project', 'project/sub', '', null]) assert.equal(isWorkspacePath(cwd, ['/project']), false);
  assert.equal(isWorkspacePath('C:\\PROJECT\\sub', ['c:/project']), true);
  assert.equal(isWorkspacePath('D:\\project', ['c:/project']), false);
  assert.equal(isWorkspacePath('c:/project-other', ['C:\\project']), false);
  assert.equal(isWorkspacePath('\\\\SERVER\\Share\\project\\sub', ['\\\\server\\share\\PROJECT']), true);
});

test('全部发布状态均不泄漏外项目列表或置顶元数据；当前项目置顶完整补齐', async () => {
  const external = thread('external-private-id', 'external-private-title', '/project-other/private-cwd');
  const app = setup({ folders: ['/project', '/second'], bridge: request => request.action === 'pins' ? { threadIds: ['pinned', external.id, 'unknown'] } : undefined,
    rpc: (method, params) => {
      if (method === 'thread/list') { assert.equal(Object.hasOwn(params, 'cwd'), false); return { data: [external, thread('child', 'child', '/project/sub'), thread('second', 'second', '/second')], nextCursor: null }; }
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        if (params.threadId === 'unknown') return Promise.reject(new Error('external-private-error'));
        return { thread: params.threadId === external.id ? external : thread('pinned') };
      }
    } });
  await app.handleMessage({ type: 'ready' });
  assert.deepEqual(app.state().threads.items.map(item => item.id), ['pinned', 'child', 'second']);
  assert.equal(app.state().threads.error, undefined);
  assert.equal(JSON.stringify(app.states).includes('external-private'), false);
});

test('扫描十页后保留续载，空的当前项目结果不伪装穷尽', async () => {
  let pages = 0;
  const app = setup({ rpc: (method, params) => {
    if (method === 'thread/list') { pages++; return { data: [thread(pages === 11 ? 'inside' : `external-${pages}`, 'title', pages === 11 ? '/project/sub' : '/other')], nextCursor: pages < 11 ? String(pages) : null }; }
  } });
  await app.handleMessage({ type: 'ready' });
  assert.equal(pages, 10); assert.deepEqual(app.state().threads.items, []);
  assert.equal(app.state().threads.hasMore, true); assert.match(app.state().threads.error, /加载更多/);
  await app.handleMessage({ type: 'loadMore' });
  assert.equal(pages, 11); assert.equal(app.state().threads.items[0].id, 'inside'); assert.equal(app.state().threads.hasMore, false);
});

test('每批五十条限制不裁掉当前项目置顶，后续批次不丢记录', async () => {
  const app = setup({ bridge: request => request.action === 'pins' ? { threadIds: ['pinned-extra'] } : undefined,
    rpc: (method, params) => {
      if (method === 'thread/list') return params.cursor ? { data: [thread('last')], nextCursor: null } : { data: Array.from({ length: 50 }, (_, i) => thread(`item-${i}`)), nextCursor: 'next' };
    } });
  await app.handleMessage({ type: 'ready' }); assert.equal(app.state().threads.items.length, 51);
  await app.handleMessage({ type: 'loadMore' }); assert.equal(app.state().threads.items.length, 52);
  assert.equal(app.state().threads.items[0].id, 'pinned-extra');
});

test('搜索跨外项目分页自动继续，任何状态不包含外项目内容', async () => {
  const app = setup({ rpc: (method, params) => {
    if (method === 'thread/search') return params.cursor ? { data: [{ thread: thread('match', 'match', '/project/sub') }], nextCursor: null }
      : { data: [{ thread: thread('hidden-id', 'hidden-title', '/hidden-cwd'), snippet: 'hidden-body' }], nextCursor: 'next' };
  } });
  await app.handleMessage({ type: 'ready' }); await app.handleMessage({ type: 'search', query: 'needle' });
  assert.deepEqual(app.state().threads.items.map(item => item.id), ['match']);
  assert.equal(JSON.stringify(app.states).includes('hidden-'), false);
});

test('无项目或远程项目不请求会话数据，账号和默认新建仍可用', async () => {
  for (const folders of [[], [{ uri: { scheme: 'vscode-remote', fsPath: '/project' } }]]) {
    const app = setup({ folders }); await app.handleMessage({ type: 'ready' });
    await app.handleMessage({ type: 'search', query: 'needle' }); await app.handleMessage({ type: 'loadMore' });
    assert.equal(app.state().account.status, 'ready'); assert.equal(app.state().usage.status, 'ready');
    assert.deepEqual(app.state().threads.items, []); assert.match(app.state().threads.error, /项目/);
    assert.equal(app.calls.some(call => call.method?.startsWith('thread/') || ['pins', 'panels'].includes(call.action)), false);
    await app.handleMessage({ type: 'newTab' }); assert.deepEqual(app.opens, ['new']);
  }
});

test('切工作区即时清列表、保留关键词，并丢弃旧请求', async () => {
  const gate = defer(); let searches = 0;
  const app = setup({ rpc: method => {
    if (method === 'thread/search') return ++searches === 1 ? gate.promise : { data: [{ thread: thread('new-project', 'new', '/second') }], nextCursor: null };
  } });
  await app.handleMessage({ type: 'ready' });
  const old = app.handleMessage({ type: 'search', query: 'needle' }); await tick();
  const changed = app.changeWorkspace(['/second']);
  assert.deepEqual(app.state().threads.items, []); assert.equal(app.state().threads.query, 'needle');
  await changed;
  gate.resolve({ data: [{ thread: thread('stale-private', 'stale-private') }], nextCursor: null }); await old;
  assert.equal(app.state().threads.items[0].id, 'new-project');
  assert.equal(app.calls.filter(call => call.method === 'thread/search' && call.params.searchTerm === 'needle').length, 2);
  assert.equal(JSON.stringify(app.states).includes('stale-private'), false);
  app.dispose(); assert.equal(app.workspaceDisposed(), true);
});

test('重命名确认中切换工作区再切回，旧确认仍不得写入', async () => {
  const gate = defer(); const app = setup({ input: () => gate.promise });
  await app.handleMessage({ type: 'ready' });
  const pending = app.handleMessage({ type: 'renameThread', threadId: 'one' }); await tick();
  await app.changeWorkspace(['/second']); await app.changeWorkspace(['/project']);
  gate.resolve('不应写入'); await pending;
  assert.equal(app.calls.some(call => call.method === 'thread/name/set'), false);
});

test('打开和置顶复核期间切项目，阻止后续副作用', async () => {
  for (const type of ['openThread', 'togglePin']) {
    const gate = defer(); const app = setup({ rpc: method => method === 'thread/read' ? gate.promise : undefined });
    await app.handleMessage({ type: 'ready' });
    const pending = app.handleMessage({ type, threadId: 'one' }); await tick();
    await app.changeWorkspace(['/second']); gate.resolve({ thread: thread('one') }); await pending;
    assert.equal(app.calls.some(call => call.action === 'reveal' || call.input), false); assert.deepEqual(app.opens, []);
  }
});

test('操作前元数据归属改变时禁止打开、重命名和置顶', async () => {
  const app = setup({ rpc: method => method === 'thread/read' ? { thread: thread('one', 'outside-secret', '/outside-secret') } : undefined });
  await app.handleMessage({ type: 'ready' });
  for (const type of ['openThread', 'renameThread', 'togglePin']) await app.handleMessage({ type, threadId: 'one' });
  assert.equal(app.calls.some(call => call.action === 'reveal' || call.input || call.method === 'thread/name/set'), false);
  assert.equal(JSON.stringify(app.states).includes('outside-secret'), false);
});

test('循环游标停止扫描并可刷新重试', async () => {
  const app = setup({ rpc: (method, params) => method === 'thread/list' ? { data: [], nextCursor: params.cursor === 'a' ? 'b' : 'a' } : undefined });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.calls.filter(call => call.method === 'thread/list').length, 3);
  assert.equal(app.state().threads.hasMore, false); assert.match(app.state().threads.error, /游标重复/);
  await app.handleMessage({ type: 'refresh' }); assert.equal(app.calls.filter(call => call.method === 'thread/list').length, 6);
});

test('归属和操作检查使用未截断原始目录', async () => {
  const root = '/project/' + 'x'.repeat(510);
  const app = setup({ folders: [root], rpc: method => {
    if (method === 'thread/list') return { data: [thread('long', 'long', root + '/sub')], nextCursor: null };
    if (method === 'thread/read') return { thread: thread('long', 'long', root + '/sub') };
  } });
  await app.handleMessage({ type: 'ready' }); assert.equal(app.state().threads.items[0].cwd.length, 500);
  await app.handleMessage({ type: 'openThread', threadId: 'long' }); assert.deepEqual(app.opens, ['long']);
});

test('ready 后每六十秒刷新账号和用量，保留搜索结果且不查询会话', async () => {
  const timers = fakeTimers(); const app = setup({ timers });
  await timers.advance(60_000); assert.equal(app.calls.length, 0);
  await app.handleMessage({ type: 'ready' }); assert.equal(timers.size(), 1); assert.equal(timers.unrefs(), 1);
  await app.handleMessage({ type: 'search', query: 'needle' });
  const threads = JSON.stringify(app.state().threads), calls = app.calls.length;
  await timers.advance(59_999); assert.equal(app.calls.length, calls);
  await timers.advance(1);
  const refreshed = app.calls.slice(calls);
  assert.deepEqual(refreshed.filter(call => call.action === 'rpc').map(call => call.method), ['account/read', 'account/rateLimits/read']);
  assert.equal(refreshed.some(call => ['pins', 'panels'].includes(call.action)), false);
  assert.equal(JSON.stringify(app.state().threads), threads);
  app.dispose(); assert.equal(timers.size(), 0);
});

test('未登录每分钟仅检查账号；重新登录后自动开始读取用量', async () => {
  let loggedIn = false; const timers = fakeTimers();
  const app = setup({ timers, rpc: method => method === 'account/read' ? { account: loggedIn ? { type: 'chatgpt', email: 'test@example.test', planType: 'pro' } : null } : undefined });
  await app.handleMessage({ type: 'ready' }); await timers.advance(120_000);
  assert.equal(app.calls.filter(call => call.method === 'account/read').length, 3);
  assert.equal(app.calls.filter(call => call.method === 'account/rateLimits/read').length, 0);
  assert.equal(app.state().account.status, 'signed-out');
  loggedIn = true; await timers.advance(60_000);
  assert.equal(app.state().account.status, 'ready'); assert.equal(app.state().usage.status, 'ready');
  assert.equal(app.calls.filter(call => call.method === 'account/rateLimits/read').length, 1);
  loggedIn = false; await timers.advance(60_000);
  assert.equal(app.state().credits.items.length, 0); assert.equal(app.state().capabilities.reset, false);
  assert.equal(app.calls.filter(call => call.method === 'account/rateLimits/read').length, 1);
  app.dispose();
});

test('慢账号请求跨多个 tick 跳过，手动刷新共用请求且无旧快照回填', async () => {
  let reads = 0; const gate = defer(); const timers = fakeTimers();
  const app = setup({ timers, rpc: method => method === 'account/read' && ++reads === 2 ? gate.promise : undefined });
  await app.handleMessage({ type: 'ready' }); await timers.advance(60_000);
  const manual = app.handleMessage({ type: 'refresh' }); await tick(); await timers.advance(180_000);
  assert.equal(app.calls.filter(call => call.method === 'account/read').length, 2);
  gate.resolve({ account: { type: 'chatgpt', email: 'fresh@example.test', planType: 'pro' } }); await manual;
  assert.equal(app.state().account.email, 'fresh@example.test');
  await timers.advance(60_000); assert.equal(app.calls.filter(call => call.method === 'account/read').length, 3);
  app.dispose();
});

test('慢会话扫描不会阻塞下一分钟账号刷新', async () => {
  const gate = defer(); const timers = fakeTimers(); const app = setup({ timers, rpc: method => method === 'thread/list' ? gate.promise : undefined });
  const loading = app.handleMessage({ type: 'ready' }); await tick();
  assert.equal(app.state().threads.loading, true);
  await timers.advance(60_000);
  assert.equal(app.calls.filter(call => call.method === 'account/read').length, 2);
  assert.equal(app.calls.filter(call => call.method === 'thread/list').length, 1);
  gate.resolve({ data: [], nextCursor: null }); await loading; app.dispose();
});

test('销毁清理计时器，迟到账号响应不再发布或读取用量', async () => {
  let reads = 0; const gate = defer(); const timers = fakeTimers();
  const app = setup({ timers, rpc: method => method === 'account/read' && ++reads === 2 ? gate.promise : undefined });
  await app.handleMessage({ type: 'ready' }); await timers.advance(60_000);
  app.dispose(); const count = app.states.length, calls = app.calls.length;
  gate.resolve({ account: { type: 'chatgpt', email: 'late@example.test' } }); await tick(); await timers.advance(120_000);
  assert.equal(app.states.length, count); assert.equal(app.calls.length, calls); assert.equal(timers.size(), 0);
});

test('桥暂不可用时每分钟静默重连，恢复后只刷新账号', async () => {
  let connected = false; const timers = fakeTimers(); const app = setup({ timers, commands: () => connected });
  await app.handleMessage({ type: 'ready' }); await timers.advance(60_000);
  assert.deepEqual(app.errors, []); assert.deepEqual(app.notices, []);
  connected = true; await timers.advance(60_000);
  assert.equal(app.state().account.status, 'ready'); assert.equal(app.state().usage.status, 'ready');
  assert.equal(app.calls.some(call => call.method?.startsWith('thread/')), false);
  app.dispose();
});

test('重置卡确认期间跳过自动刷新，保留 busy 状态', async () => {
  const gate = defer(); const timers = fakeTimers(); const app = setup({ timers, warning: () => gate.promise });
  await app.handleMessage({ type: 'ready' });
  const pending = app.handleMessage({ type: 'resetCredit', creditId: card.id }); await tick();
  const calls = app.calls.length;
  await timers.advance(120_000);
  assert.equal(app.calls.length, calls); assert.equal(app.state().credits.busyId, card.id);
  gate.resolve(undefined); await pending;
  assert.equal(app.calls.some(call => call.method?.endsWith('/consume')), false); app.dispose();
});

test('运行态初次加载并每两秒只查可见项目 ID，额外返回内容不发布', async () => {
  const timers = fakeTimers(); let isRunning = true;
  const app = setup({ timers, runtime: true, bridge: request => request.action === 'runtime' ? {
    supported: true, threads: [{ threadId: 'one', isRunning, runningTurnId: 'turn-current' }, { threadId: 'outside-secret', isRunning: true, runningTurnId: 'outside-secret' }],
  } : undefined });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().threads.items[0].isRunning, true); assert.equal(app.state().capabilities.stop, true);
  assert.deepEqual(app.calls.find(call => call.action === 'runtime').threadIds, ['one']);
  const count = app.calls.length;
  await timers.advance(1999); assert.equal(app.calls.length, count);
  isRunning = false; await timers.advance(1);
  assert.equal(app.calls.length, count + 1); assert.equal(app.calls.at(-1).action, 'runtime');
  assert.equal(app.state().threads.items[0].isRunning, false); assert.equal(app.state().threads.items[0].runningTurnId, undefined);
  assert.equal(JSON.stringify(app.states).includes('outside-secret'), false);
  app.dispose(); assert.equal(timers.size(), 0);
});

test('旧桥、无项目与未知运行态均没有可执行停止入口', async () => {
  for (const options of [{}, { runtime: true, folders: [] }]) {
    const timers = fakeTimers(); const app = setup({ ...options, timers });
    await app.handleMessage({ type: 'ready' }); await timers.advance(4000);
    await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
    assert.equal(app.calls.some(call => call.action === 'runtime' || call.action === 'stop'), false); app.dispose();
  }
  const app = setup({ runtime: true, bridge: request => request.action === 'runtime' ? { supported: false, threads: [] } : undefined });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().capabilities.stop, false); assert.equal(app.state().threads.items[0].isRunning, undefined);
  await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
  assert.equal(app.calls.some(call => call.action === 'stop'), false); app.dispose();
});

test('慢运行态请求不重叠，查询切换后旧响应不回填', async () => {
  const gate = defer(); const timers = fakeTimers(); let reads = 0;
  const app = setup({ timers, runtime: true, bridge: request => request.action === 'runtime' && ++reads === 2 ? gate.promise : undefined });
  await app.handleMessage({ type: 'ready' }); await timers.advance(2000); await timers.advance(6000);
  assert.equal(reads, 2);
  await app.handleMessage({ type: 'search', query: 'needle' });
  gate.resolve({ supported: true, threads: [{ threadId: 'one', isRunning: true, runningTurnId: 'stale-private' }] }); await tick();
  assert.equal(app.state().threads.query, 'needle'); assert.equal(app.state().threads.items[0].id, 'found');
  assert.equal(JSON.stringify(app.states).includes('stale-private'), false);
  const listCount = app.calls.filter(call => call.method?.startsWith('thread/')).length;
  await timers.advance(2000);
  assert.deepEqual(app.calls.at(-1).threadIds, ['found']);
  assert.equal(app.calls.filter(call => call.method?.startsWith('thread/')).length, listCount); app.dispose();
});

test('切工作区或销毁后丢弃运行态迟响应', async () => {
  for (const close of [false, true]) {
    const gate = defer(); const timers = fakeTimers(); let reads = 0;
    const app = setup({ timers, runtime: true, bridge: request => request.action === 'runtime' && ++reads === 2 ? gate.promise : undefined });
    await app.handleMessage({ type: 'ready' }); await timers.advance(2000);
    if (close) app.dispose(); else await app.changeWorkspace(['/other']);
    const count = app.states.length;
    gate.resolve({ supported: true, threads: [{ threadId: 'one', isRunning: true, runningTurnId: 'stale-turn' }] }); await tick();
    assert.equal(app.states.length, count); assert.equal(JSON.stringify(app.states).includes('stale-turn'), false); app.dispose();
  }
});

test('停止只发送当前精确轮次，并发点击合并且成功后不乐观标停', async () => {
  const gate = defer(); const app = setup({ runtime: true, bridge: request => request.action === 'stop' ? gate.promise : undefined });
  await app.handleMessage({ type: 'ready' });
  await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'old-turn' });
  assert.equal(app.calls.some(call => call.action === 'stop'), false);
  const first = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
  const second = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' }); await tick();
  assert.equal(app.state().threads.items[0].stopping, true);
  assert.deepEqual(app.calls.filter(call => call.action === 'stop'), [{ action: 'stop', threadId: 'one', turnId: 'turn-current', token: 'test-stop-ticket' }]);
  gate.resolve({ interrupted: true }); await Promise.all([first, second]);
  assert.equal(app.state().threads.items[0].isRunning, true); assert.equal(app.state().threads.items[0].stopping, false);
  assert.equal(app.calls.at(-1).action, 'runtime'); app.dispose();
});

test('停止前复核期间变成新轮次，旧点击不发停止', async () => {
  const gate = defer(); const timers = fakeTimers(); let turnId = 'turn-current';
  const app = setup({ runtime: true, timers, rpc: method => method === 'thread/read' ? gate.promise : undefined,
    bridge: request => request.action === 'runtime' ? { supported: true, threads: [{ threadId: 'one', isRunning: true, runningTurnId: turnId }] } : undefined });
  await app.handleMessage({ type: 'ready' });
  const pending = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' }); await tick();
  turnId = 'turn-new'; await timers.advance(2000);
  gate.resolve({ thread: thread('one') }); await pending;
  assert.equal(app.calls.some(call => call.action === 'stop'), false);
  assert.equal(app.state().threads.items[0].runningTurnId, 'turn-new'); app.dispose();
});

test('停止复核期间切项目或销毁，不再向官方发停止', async () => {
  for (const close of [false, true]) {
    const gate = defer(); const app = setup({ runtime: true, rpc: method => method === 'thread/read' ? gate.promise : undefined });
    await app.handleMessage({ type: 'ready' });
    const pending = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' }); await tick();
    if (close) app.dispose(); else await app.changeWorkspace(['/other']);
    gate.resolve({ thread: thread('one') }); await pending;
    assert.equal(app.calls.some(call => call.action === 'stop'), false); app.dispose();
  }
});

test('停止失败重读状态并给安全提示，不重试也不泄漏官方错误正文', async () => {
  const app = setup({ runtime: true, bridge: request => request.action === 'stop' ? Promise.reject(new Error('private-provider-body')) : undefined });
  await app.handleMessage({ type: 'ready' });
  await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
  assert.equal(app.calls.filter(call => call.action === 'stop').length, 1);
  assert.equal(app.calls.at(-1).action, 'runtime'); assert.match(app.errors[0], /不会自动重试/);
  assert.equal(JSON.stringify([app.states, app.errors]).includes('private-provider-body'), false); app.dispose();
});

test('大量当前项目置顶的运行态按二百条分批且完整覆盖', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `pin-${index}`);
  const app = setup({ runtime: true, bridge: request => request.action === 'pins' ? { threadIds: ids } : undefined });
  await app.handleMessage({ type: 'ready' });
  const requests = app.calls.filter(call => call.action === 'runtime');
  assert.deepEqual(requests.map(call => call.threadIds.length), [200, 6]);
  assert.equal(app.state().threads.items.length, 206);
  assert.equal(app.state().threads.items.every(item => item.isRunning && item.runningTurnId === 'turn-current'), true);
  app.dispose();
});

test('运行中但轮次未知不能停止；运行态读取失败撤下入口并可恢复', async () => {
  const timers = fakeTimers(); let mode = 'unknown';
  const app = setup({ runtime: true, timers, bridge: request => {
    if (request.action !== 'runtime') return;
    if (mode === 'failed') return Promise.reject(new Error('private-runtime-error'));
    return { supported: true, threads: [{ threadId: 'one', isRunning: true, runningTurnId: mode === 'known' ? 'turn-current' : undefined }] };
  } });
  await app.handleMessage({ type: 'ready' });
  assert.equal(app.state().threads.items[0].isRunning, true);
  await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
  assert.equal(app.calls.some(call => call.action === 'stop'), false);
  mode = 'failed'; await timers.advance(2000);
  assert.equal(app.state().capabilities.stop, false); assert.equal(app.state().threads.items[0].isRunning, undefined);
  mode = 'known'; await timers.advance(2000);
  assert.equal(app.state().capabilities.stop, true); assert.equal(app.state().threads.items[0].runningTurnId, 'turn-current');
  assert.equal(JSON.stringify(app.states).includes('private-runtime-error'), false); assert.deepEqual(app.errors, []); app.dispose();
});

test('准备停止票据期间切项目、销毁或切查询，不提交票据', async () => {
  for (const action of ['workspace', 'dispose', 'search']) {
    const gate = defer(); const app = setup({ runtime: true, bridge: request => request.action === 'prepareStop' ? gate.promise : undefined });
    await app.handleMessage({ type: 'ready' });
    const pending = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' }); await tick();
    assert.equal(app.calls.filter(call => call.action === 'prepareStop').length, 1);
    if (action === 'workspace') await app.changeWorkspace(['/other']);
    else if (action === 'dispose') app.dispose();
    else await app.handleMessage({ type: 'search', query: 'needle' });
    gate.resolve({ token: 'prepared-ticket' }); await pending;
    assert.equal(app.calls.some(call => call.action === 'stop'), false); app.dispose();
  }
});

test('准备停止票据期间新轮次开始，不误提交旧轮次票据', async () => {
  const gate = defer(); const timers = fakeTimers(); let turnId = 'turn-current';
  const app = setup({ runtime: true, timers, bridge: request => {
    if (request.action === 'prepareStop') return gate.promise;
    if (request.action === 'runtime') return { supported: true, threads: [{ threadId: 'one', isRunning: true, runningTurnId: turnId }] };
  } });
  await app.handleMessage({ type: 'ready' });
  const pending = app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' }); await tick();
  turnId = 'turn-new'; await timers.advance(2000);
  gate.resolve({ token: 'prepared-ticket' }); await pending;
  assert.equal(app.calls.some(call => call.action === 'stop'), false);
  assert.equal(app.state().threads.items[0].runningTurnId, 'turn-new'); app.dispose();
});

test('无法取得停止票据时只重读状态并提示，不发停止', async () => {
  const app = setup({ runtime: true, bridge: request => request.action === 'prepareStop' ? { token: null } : undefined });
  await app.handleMessage({ type: 'ready' });
  await app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-current' });
  assert.equal(app.calls.some(call => call.action === 'stop'), false);
  assert.equal(app.calls.at(-1).action, 'runtime'); assert.match(app.errors[0], /不会自动重试/);
  app.dispose();
});
