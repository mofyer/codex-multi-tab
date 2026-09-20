'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountController } = require('../src/accounts/account-controller');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const profile = { id: 'saved-b', email: 'b@example.test', accountId: 'workspace-b', planType: 'pro', label: 'Work' };

function setup(options = {}) {
  const states = [], calls = [], errors = [], values = new Map(), intervals = new Set();
  let saved = 0, switched = 0, rolledBack = 0, refreshes = 0;
  const account = { type: 'chatgpt', email: 'a@example.test', accountId: 'workspace-a' };
  const store = {
    async checkSupport() { if (options.unsupported) throw new Error('private config'); },
    async list() { return [{ ...profile, secret: 'MUST_NOT_LEAK' }]; },
    async saveCurrent(value) { assert.ok(value); saved++; },
    async stageSwitch(id, _value, beforeWrite) { assert.equal(id, profile.id); if (beforeWrite) await beforeWrite(); switched++; if (options.stage) await options.stage(); return { changed: true, cleanupWarning: options.cleanupWarning, async rollback() { rolledBack++; if (options.rollback) await options.rollback(); return true; } }; },
    async rename() {}, async remove() {},
  };
  const bridge = async request => {
    calls.push(request);
    if (options.bridge) { const value = options.bridge(request); if (value !== undefined) return value; }
    if (request.action === 'status') return { capabilities: { accounts: !options.oldBridge } };
    if (request.action === 'accountEnvironment') return { supported: true, home: '/mock/codex' };
    if (request.action === 'accountSwitchPreflight') return { safe: !options.active };
    if (request.action === 'accountLogin') return { loginId: 'login-test', authUrl: options.url || 'https://auth.openai.com/authorize?state=private' };
    if (request.action === 'accountLoginStatus') return options.loginResult || { status: 'pending' };
    if (request.action === 'cancelAccountLogin') return {};
    if (request.method === 'account/read') return { account };
    if (request.method === 'account/rateLimits/read') return { accountId: account.accountId };
    throw new Error('unexpected');
  };
  const vscode = {
    commands: { async executeCommand(command) { calls.push(command); if (options.reloadFails) throw new Error('TOKEN DO NOT DISPLAY'); } },
    window: { async showErrorMessage(value) { errors.push(value); if (options.errorNotice) return options.errorNotice(); }, async showInputBox() { return 'Updated'; }, async showWarningMessage() { return options.remove ? '移除账号' : undefined; } },
    env: { async openExternal() { return options.browser !== false; } }, Uri: { parse(value) { return value; } },
  };
  const context = { globalState: { get: key => values.get(key), async update(key, value) { values.set(key, value); } } };
  const controller = createAccountController(vscode, context, {
    bridge, changed: state => states.push(state), refresh: async () => { refreshes++; },
    waitForAccount: async () => {}, canStart: () => !options.resetBusy, storeFactory: () => store,
    timers: { setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); } },
  });
  return { controller, states, calls, errors, values, intervals, account, context,
    async init() { await controller.update(account); },
    stats: () => ({ saved, switched, rolledBack, refreshes }),
    async tick() { for (const fn of intervals) fn(); for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('saved account state explicitly projects metadata and uses workspace identity', async () => {
  const app = setup(); await app.init();
  assert.equal(JSON.stringify(app.states).includes('MUST_NOT_LEAK'), false);
  assert.equal(app.states.at(-1).items[0].isCurrent, false);
  await app.controller.update({ email: profile.email, accountId: profile.accountId });
  assert.equal(app.states.at(-1).items[0].isCurrent, true);
});

test('single-click switch stages once and reloads, duplicate and reset actions cannot interleave', async () => {
  const gate = deferred(); const app = setup({ stage: () => gate.promise }); await app.init();
  const first = app.controller.handle('switchAccount', profile.id);
  await app.controller.handle('switchAccount', profile.id);
  gate.resolve(); await first;
  assert.equal(app.stats().switched, 1);
  assert.deepEqual(app.calls.filter(value => typeof value === 'string'), ['workbench.action.reloadWindow']);
  assert.equal(app.controller.busy, true);
  const blocked = setup({ resetBusy: true }); await blocked.init();
  await blocked.controller.handle('switchAccount', profile.id);
  assert.equal(blocked.stats().switched, 0);
});

test('active or unknown runtime and unlisted targets never write credentials', async () => {
  for (const options of [{ active: true }, { bridge: request => request.action === 'accountSwitchPreflight' ? {} : undefined }]) {
    const app = setup(options); await app.init(); await app.controller.handle('switchAccount', profile.id);
    assert.equal(app.stats().switched, 0);
  }
  const app = setup(); await app.init(); await app.controller.handle('switchAccount', '../untrusted');
  assert.equal(app.stats().switched, 0);
});

test('reload failure rolls back and errors never expose underlying token details', async () => {
  const app = setup({ reloadFails: true }); await app.init(); await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().rolledBack, 1);
  assert.equal(app.controller.busy, false);
  assert.equal(app.values.get('codexMultiTab.pendingAccountSwitch'), undefined);
  assert.equal(app.errors.join().includes('TOKEN'), false);
});

test('switch failures explain known store errors without exposing exception details', async () => {
  const cases = [
    ['BUSY', /另一个窗口.*操作锁/],
    ['IDENTITY', /身份.*刷新/],
    ['CHANGED', /登录文件.*未覆盖/],
    ['INVALID_AUTH', /凭据格式.*重新登录/],
    ['NOT_FOUND', /账号不存在.*刷新/],
    ['STORAGE', /安全存储.*权限/],
    ['UNSUPPORTED', /存储环境.*确认/],
  ];
  for (const [code, expected] of cases) {
    const cause = Object.assign(new Error('PRIVATE_TOKEN'), { code: `CODEX_MULTI_TAB_ACCOUNT_${code}` });
    const app = setup({ stage: () => { throw cause; } });
    await app.init(); await app.controller.handle('switchAccount', profile.id);
    assert.match(app.errors.at(-1), expected, code);
    assert.equal(app.states.at(-1).message, app.errors.at(-1));
    assert.equal(JSON.stringify([app.errors, app.states]).includes('PRIVATE_TOKEN'), false);
    assert.equal(app.controller.busy, false);
    assert.equal(app.values.get('codexMultiTab.pendingAccountSwitch'), undefined);
    assert.equal(app.calls.includes('workbench.action.reloadWindow'), false);
  }
});

test('environment changes during an operation show the safe environment reason', async () => {
  let reason;
  const app = setup({ bridge: request => request.action === 'accountEnvironment' && reason
    ? { supported: false, reason, message: 'PRIVATE_TOKEN' } : undefined });
  await app.init(); reason = 'auth-storage-unsupported';
  await app.controller.handle('switchAccount', profile.id);
  assert.match(app.errors.at(-1), /非文件式/);
  assert.equal(app.stats().switched, 0);
  assert.equal(JSON.stringify([app.errors, app.states]).includes('PRIVATE_TOKEN'), false);
});

test('unknown and inherited error codes keep the generic safe operation message', async () => {
  for (const code of [undefined, 'PRIVATE_TOKEN', 'toString', '__proto__', 'constructor']) {
    const cause = Object.assign(new Error('PRIVATE_TOKEN'), { code });
    const app = setup({ stage: () => { throw cause; } });
    await app.init(); await app.controller.handle('switchAccount', profile.id);
    assert.match(app.errors.at(-1), /^账号操作未完成。/);
    assert.equal(app.states.at(-1).message, app.errors.at(-1));
    assert.equal(JSON.stringify([app.errors, app.states]).includes('PRIVATE_TOKEN'), false);
  }
});

test('rollback failure takes precedence over the initial operation error', async () => {
  const app = setup({ reloadFails: true, rollback: () => { throw new Error('PRIVATE_TOKEN'); } });
  await app.init(); await app.controller.handle('switchAccount', profile.id);
  assert.match(app.errors.at(-1), /切换未完成.*缓存已发生变化.*检查当前登录/);
  assert.equal(app.states.at(-1).message, app.errors.at(-1));
  assert.equal(JSON.stringify([app.errors, app.states]).includes('PRIVATE_TOKEN'), false);
});

test('an open error notification does not hold the account operation busy', async () => {
  const notice = deferred();
  const app = setup({ stage: () => { throw new Error('failure'); }, errorNotice: () => notice.promise });
  await app.init();
  let completed = false;
  const operation = app.controller.handle('switchAccount', profile.id).then(() => { completed = true; });
  try {
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.errors.length, 1);
    assert.equal(app.controller.busy, false);
    assert.equal(completed, true);
    assert.equal(app.stats().refreshes, 1);
    assert.equal(app.values.get('codexMultiTab.pendingAccountSwitch'), undefined);
  } finally { notice.resolve(); await operation; }
});

test('notification delivery failure does not reject account handling or retain busy state', async () => {
  const app = setup({ stage: () => { throw new Error('failure'); }, errorNotice: () => Promise.reject(new Error('notice failed')) });
  await app.init();
  await assert.doesNotReject(app.controller.handle('switchAccount', profile.id));
  assert.equal(app.controller.busy, false);
  assert.equal(app.stats().refreshes, 1);
});

test('unsupported environments and old bridges disable account features', async () => {
  for (const options of [{ unsupported: true }, { oldBridge: true }]) {
    const app = setup(options); await app.init();
    assert.equal(app.states.at(-1).supported, false);
    await app.controller.handle('addAccount');
    assert.equal(app.calls.some(value => value?.action === 'accountLogin'), false);
  }
});

test('browser login preserves current credentials and only stores new account after completion', async () => {
  const app = setup({ loginResult: { status: 'success', success: true } }); await app.init();
  await app.controller.handle('addAccount');
  assert.equal(app.stats().saved, 1);
  assert.equal(app.controller.busy, true);
  assert.equal(JSON.stringify(app.states).includes('state=private'), false);
  await app.tick();
  assert.equal(app.stats().saved, 2);
  assert.equal(app.controller.busy, false);
  assert.equal(app.intervals.size, 0);
});

test('unsafe auth URL and browser failure cancel the pending official login', async () => {
  for (const options of [{ url: 'https://evil.example/auth' }, { browser: false }]) {
    const app = setup(options); await app.init(); await app.controller.handle('addAccount');
    assert.ok(app.calls.some(value => value?.action === 'cancelAccountLogin'));
    assert.equal(app.stats().saved, 1);
    assert.equal(app.intervals.size, 0);
    assert.equal(app.controller.busy, false);
  }
});

test('cancel login clears polling without removing saved accounts', async () => {
  const app = setup(); await app.init(); await app.controller.handle('addAccount');
  await app.controller.handle('cancelAccountLogin');
  assert.equal(app.stats().saved, 1);
  assert.equal(app.controller.busy, false);
  assert.equal(app.intervals.size, 0);
});

test('post-reload verification waits for exact account and workspace', async () => {
  const app = setup(); await app.init();
  await app.context.globalState.update('codexMultiTab.pendingAccountSwitch', { id: profile.id, home: '/mock/codex' });
  await app.controller.update({ email: profile.email, accountId: 'different' });
  assert.ok(app.values.get('codexMultiTab.pendingAccountSwitch'));
  await app.controller.update({ email: profile.email, accountId: profile.accountId });
  assert.equal(app.values.get('codexMultiTab.pendingAccountSwitch'), undefined);
  assert.match(app.states.at(-1).message, /已切换/);
});

test('cancelled window reload restores cache and clears busy state; successful disposal cancels recovery', async () => {
  const app = setup(); await app.init(); await app.controller.handle('switchAccount', profile.id);
  await app.tick();
  assert.equal(app.stats().rolledBack, 1);
  assert.equal(app.controller.busy, false);
  assert.equal(app.intervals.size, 0);
  const completed = setup(); await completed.init(); await completed.controller.handle('switchAccount', profile.id);
  completed.controller.dispose(); await completed.tick();
  assert.equal(completed.stats().rolledBack, 0);
  assert.equal(completed.intervals.size, 0);
});

test('disposing while login starts cancels the returned login without opening a timer', async () => {
  const gate = deferred();
  const app = setup({ bridge: request => request.action === 'accountLogin' ? gate.promise : undefined });
  await app.init(); const operation = app.controller.handle('addAccount');
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  app.controller.dispose(); gate.resolve({ loginId: 'late-login', authUrl: 'https://auth.openai.com/authorize' });
  await operation;
  assert.ok(app.calls.some(value => value?.action === 'cancelAccountLogin' && value.loginId === 'late-login'));
  assert.equal(app.intervals.size, 0);
});

test('a task starting after credential staging aborts reload and restores the original cache', async () => {
  let staged = false;
  const app = setup({ stage: () => { staged = true; }, bridge: request => request.action === 'accountSwitchPreflight' ? { safe: !staged } : undefined });
  await app.init(); await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().rolledBack, 1);
  assert.equal(app.calls.some(value => value === 'workbench.action.reloadWindow'), false);
});

test('effective managed workspace restrictions block an incompatible saved account', async () => {
  const app = setup({ bridge: request => request.action === 'accountEnvironment'
    ? { supported: true, home: '/mock/codex', forcedWorkspaceIds: ['different-workspace'] } : undefined });
  await app.init(); await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().switched, 0);
});

test('status errors cancel official pending login before allowing other account operations', async () => {
  const app = setup({ bridge: request => request.action === 'accountLoginStatus' ? Promise.reject(new Error('RPC failure')) : undefined });
  await app.init(); await app.controller.handle('addAccount'); await app.tick();
  assert.ok(app.calls.some(value => value?.action === 'cancelAccountLogin'));
  assert.equal(app.controller.busy, false);
});

test('unconfirmed cancellation keeps login pending and blocks switching', async () => {
  const app = setup({ bridge: request => ['accountLoginStatus', 'cancelAccountLogin'].includes(request.action) ? Promise.reject(new Error('offline')) : undefined });
  await app.init(); await app.controller.handle('addAccount'); await app.tick();
  assert.equal(app.controller.busy, true);
  await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().switched, 0);
  app.controller.dispose();
});

test('login cancellation does not depend on configuration still being readable', async () => {
  let broken = false;
  const app = setup({ bridge: request => broken && request.action === 'accountEnvironment' ? Promise.reject(new Error('config')) : undefined });
  await app.init(); await app.controller.handle('addAccount'); broken = true;
  await app.controller.handle('cancelAccountLogin');
  assert.ok(app.calls.some(value => value?.action === 'cancelAccountLogin'));
  assert.equal(app.controller.busy, false);
});

test('a committed switch with lock cleanup warning is rolled back without reloading', async () => {
  const app = setup({ cleanupWarning: 'safe warning' }); await app.init();
  await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().rolledBack, 1);
  assert.equal(app.calls.some(value => value === 'workbench.action.reloadWindow'), false);
  assert.equal(app.controller.busy, false);
});

test('failed browser open with unconfirmed cancellation keeps account operations locked', async () => {
  const app = setup({ browser: false, bridge: request => request.action === 'cancelAccountLogin' ? Promise.reject(new Error('offline')) : undefined });
  await app.init(); await app.controller.handle('addAccount');
  assert.equal(app.controller.busy, true);
  assert.match(app.errors.at(-1), /暂未确认官方登录已取消.*暂停其他账号操作/);
  assert.equal(app.states.at(-1).message, app.errors.at(-1));
  await app.controller.handle('switchAccount', profile.id);
  assert.equal(app.stats().switched, 0);
  app.controller.dispose();
});

test('outdated bridge explicitly asks for reload without blaming credential storage', async () => {
  const app = setup({ oldBridge: true }); await app.init();
  assert.match(app.states.at(-1).message, /旧版连接桥.*重载窗口/);
  assert.equal(app.states.at(-1).message.includes('钥匙串'), false);
});

test('environment failures expose only known diagnostics rather than raw server content', async () => {
  for (const reason of ['config-unavailable', 'auth-storage-unsupported', 'wsl', 'remote', 'private-secret']) {
    const app = setup({ bridge: request => request.action === 'accountEnvironment'
      ? { supported: false, reason, message: 'private-secret' } : undefined });
    await app.init();
    assert.equal(app.states.at(-1).supported, false);
    assert.equal(app.states.at(-1).message.includes('private-secret'), false);
    if (reason === 'config-unavailable') assert.match(app.states.at(-1).message, /有效配置/);
    if (reason === 'auth-storage-unsupported') assert.match(app.states.at(-1).message, /非文件式/);
  }
});
