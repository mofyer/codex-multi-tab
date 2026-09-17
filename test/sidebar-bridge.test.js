'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { registerSidebarBridge } = require('../src/compatibility/sidebar-bridge-patch');

function fixture(t, respond = () => ({}), timeoutMs = 1000) {
  let callbacks;
  const sent = [];
  const host = {
    appServerClient: {
      isLocal: true, runsInsideWsl: false, hostConfig: { id: 'local', kind: 'local' },
      async codexHome() { return '/Users/test/.codex'; }, async platformPath() { return path.posix; },
    },
    editorPanels: new Map(),
    codexMcpConnection: {
      registerProvider(name, value) { callbacks = value; return { dispose() {} }; },
      sendRequest(provider, id, method, params) {
        sent.push({ method, params });
        Promise.resolve().then(() => method === 'config/read' && !host.effectiveConfigResponder
          ? { config: { cli_auth_credentials_store: 'file' } } : respond(method, params)).then(result => {
          if (result !== undefined) callbacks.onResult({ id, result });
        }, () => callbacks.onResult({ id, error: { message: 'private-secret' } }));
      },
      abandonRequest() {},
    },
  };
  const vscode = { env: {}, commands: { registerCommand() { return { dispose() {} }; } } };
  const register = vm.runInNewContext(`(${registerSidebarBridge.toString()})`, { setTimeout, clearTimeout, URL, URLSearchParams, Date });
  const bridge = register(host, vscode, { subscriptions: [] }, () => {}, timeoutMs);
  t.after(() => bridge.dispose());
  return { host, vscode, sent, bridge, notify: message => callbacks.onNotification(message),
    call: request => bridge.handle(request) };
}

test('账号桥保持v1且仅开放专用action，RPC不可读取token/config或发起登录', async t => {
  const f = fixture(t);
  const status = await f.call({ action: 'status' });
  assert.equal(status.version, 1);
  assert.equal(status.capabilities.accounts, true);
  for (const method of ['account/login/start', 'account/login/cancel', 'thread/loaded/list', 'config/read', 'getAuthStatus', 'account/logout']) {
    await assert.rejects(f.call({ action: 'rpc', method, params: {} }), { code: 'CODEX_MULTI_TAB_UNSUPPORTED_METHOD' });
  }
  assert.equal(f.sent.length, 0);
});

test('本机home由官方ExecutionHost确认，远程/WSL/不明路径拒绝', async t => {
  const f = fixture(t);
  assert.equal((await f.call({ action: 'accountEnvironment' })).home, '/Users/test/.codex');
  const original = f.host.appServerClient;
  for (const change of [{ isLocal: false }, { isLocal: () => true }, { runsInsideWsl: true },
    { runsInsideWsl: undefined }, { hostConfig: { id: 'local', kind: 'ssh' } },
    { hostConfig: { id: 'different', kind: 'local' } }, { codexHome: undefined },
    { codexHome: async () => '../.codex' }, { codexHome: async () => '/Users/test/../.codex' },
    { codexHome: async () => '/' }, { codexHome: async () => '//remote/.codex' },
    { codexHome: async () => '/Users/\x00secret' }, { platformPath: async () => null }]) {
    f.host.appServerClient = { ...original, ...change };
    const result = await f.call({ action: 'accountEnvironment' });
    assert.equal(result.supported, false);
    assert.equal(result.home, undefined);
  }
  f.host.appServerClient = original;
  f.vscode.env.remoteName = 'ssh-remote';
  assert.equal((await f.call({ action: 'accountEnvironment' })).supported, false);
  await assert.rejects(f.call({ action: 'accountLogin' }));
  assert.equal(f.sent.filter(request => request.method !== 'config/read').length, 0);
});

test('环境查询与账号RPC有超时且错误不泄密', async t => {
  const f = fixture(t, () => undefined, 10);
  await assert.rejects(f.call({ action: 'accountLogin' }), { code: 'CODEX_MULTI_TAB_RPC_TIMEOUT' });
  f.host.appServerClient.codexHome = () => new Promise(() => {});
  assert.equal((await f.call({ action: 'accountEnvironment' })).supported, false);
});

test('环境只投影有效配置，拒绝keyring/auto/未知存储与受限登录方式', async t => {
  let config;
  const f = fixture(t, () => ({ config, origins: { private: 'private-secret' } }));
  f.host.effectiveConfigResponder = true;
  for (const value of [{}, { cli_auth_credentials_store: 'auto' }, { cli_auth_credentials_store: 'keyring' },
    { cli_auth_credentials_store: 'file', forced_login_method: 'api' },
    { cli_auth_credentials_store: 'file', forced_chatgpt_workspace_id: ['../invalid'] }]) {
    config = value;
    assert.equal((await f.call({ action: 'accountEnvironment' })).supported, false);
  }
  for (const forced of ['workspace-a', ['workspace-a', 'workspace-b']]) {
    config = { cli_auth_credentials_store: 'file', forced_chatgpt_workspace_id: forced,
      forced_login_method: 'chatgpt', secret: 'private-secret' };
    const value = await f.call({ action: 'accountEnvironment' });
    assert.equal(value.supported, true);
    assert.equal(value.authStorage, 'file');
    assert.equal(value.forcedWorkspaceIds[0], 'workspace-a');
    assert.equal(JSON.stringify(value).includes('private-secret'), false);
  }
  assert.ok(f.sent.every(request => request.method === 'config/read' && request.params.includeLayers === false));
});

test('环境失败按稳定原因区分远程、WSL、本机与目录且不泄露异常', async t => {
  const f = fixture(t);
  const original = f.host.appServerClient;
  for (const [remoteName, change, reason] of [
    ['ssh-remote', {}, 'remote'], ['wsl', {}, 'wsl'],
    [undefined, { runsInsideWsl: true }, 'wsl'],
    [undefined, { runsInsideWsl: undefined }, 'local-host-unavailable'],
    [undefined, { isLocal: false }, 'local-host-unavailable'],
    [undefined, { codexHome: async () => '../private-secret' }, 'home-unavailable'],
    [undefined, { codexHome: async () => { throw new Error('private-secret'); } }, 'home-unavailable'],
  ]) {
    f.vscode.env.remoteName = remoteName;
    f.host.appServerClient = { ...original, ...change };
    const result = await f.call({ action: 'accountEnvironment' });
    assert.equal(result.supported, false);
    assert.equal(result.reason, reason);
    assert.equal(typeof result.message, 'string');
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
    assert.deepEqual(Object.keys(result).sort(), ['message', 'reason', 'supported']);
  }
});

test('环境配置失败区分缓存模式、登录限制、工作区限制和读取失败', async t => {
  let response;
  const f = fixture(t, () => {
    if (response instanceof Error) throw response;
    return response;
  });
  f.host.effectiveConfigResponder = true;
  const cases = [
    [null, 'config-unavailable'], [new Error('private-secret'), 'config-unavailable'],
    [{ config: {} }, 'auth-storage-unsupported'],
    ...['keyring', 'auto', 'ephemeral', 'private-secret', '__proto__'].map(storage => [
      { config: { cli_auth_credentials_store: storage } }, 'auth-storage-unsupported', storage,
    ]),
    [{ config: { cli_auth_credentials_store: 'file', forced_login_method: 'api' } }, 'login-method-restricted'],
    [{ config: { cli_auth_credentials_store: 'file', forced_chatgpt_workspace_id: ['../private-secret'] } }, 'workspace-restriction-invalid'],
  ];
  const storageMessages = { keyring: /钥匙串/, auto: /自动选择/, ephemeral: /内存/ };
  for (const [value, reason, storage] of cases) {
    response = value;
    const result = await f.call({ action: 'accountEnvironment' });
    assert.equal(result.supported, false);
    assert.equal(result.reason, reason);
    assert.equal(typeof result.message, 'string');
    if (Object.hasOwn(storageMessages, storage)) assert.match(result.message, storageMessages[storage]);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
    assert.deepEqual(Object.keys(result).sort(), ['message', 'reason', 'supported']);
  }
});

test('目录与配置查询超时均返回安全稳定的超时原因', async t => {
  for (const phase of ['home', 'config']) {
    const f = fixture(t, () => undefined, 10);
    if (phase === 'home') f.host.appServerClient.codexHome = () => new Promise(() => {});
    else f.host.effectiveConfigResponder = true;
    const result = await f.call({ action: 'accountEnvironment' });
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'environment-timeout');
    assert.match(result.message, /超时/);
  }
});

test('登录只返回安全URL/id；通知安全轮询成功、失败与取消', async t => {
  const f = fixture(t, method => method === 'account/login/start'
    ? { type: 'chatgpt', loginId: 'test-login', authUrl: 'https://auth.openai.com/authorize?state=synthetic', token: 'private-secret' }
    : { status: 'canceled', private: 'private-secret' });
  const login = await f.call({ action: 'accountLogin' });
  assert.equal(login.loginId, 'test-login');
  assert.equal(Object.keys(login).length, 2);
  assert.equal(f.sent.find(request => request.method === 'account/login/start').params.type, 'chatgpt');
  assert.equal((await f.call({ action: 'accountLoginStatus', loginId: login.loginId })).status, 'pending');
  f.notify({ method: 'account/login/completed', params: { loginId: login.loginId, success: true, error: 'private-secret' } });
  assert.equal((await f.call({ action: 'accountLoginStatus', loginId: login.loginId })).success, true);
  f.notify({ method: 'account/login/completed', params: { loginId: login.loginId, success: false, error: 'private-secret' } });
  assert.equal(JSON.stringify(await f.call({ action: 'accountLoginStatus', loginId: login.loginId })).includes('private-secret'), false);
  assert.equal((await f.call({ action: 'cancelAccountLogin', loginId: login.loginId })).status, 'canceled');
  await assert.rejects(f.call({ action: 'cancelAccountLogin', loginId: 'unowned-id' }));
  await assert.rejects(f.call({ action: 'cancelAccountLogin', loginId: '../bad' }));
  f.notify({ method: 'account/login/completed', params: { loginId: 'unowned-id', success: true } });
  assert.equal((await f.call({ action: 'accountLoginStatus', loginId: 'unowned-id' })).status, 'unknown');
});

test('登录完成通知可先于start响应抵达；登录记录有界', async t => {
  let index = 0;
  const f = fixture(t, () => {
    const loginId = `login-${++index}`;
    f.notify({ method: 'account/login/completed', params: { loginId, success: true } });
    return { type: 'chatgpt', loginId, authUrl: 'https://auth.openai.com/authorize' };
  });
  for (let i = 0; i < 21; i++) await f.call({ action: 'accountLogin' });
  assert.equal((await f.call({ action: 'accountLoginStatus', loginId: 'login-21' })).success, true);
  assert.equal((await f.call({ action: 'accountLoginStatus', loginId: 'login-1' })).status, 'unknown');
});

test('账号登录拒绝伪造域、http、用户信息与非官方端口', async t => {
  let authUrl;
  const f = fixture(t, () => ({ type: 'chatgpt', loginId: 'test-login', authUrl }));
  for (const value of ['http://auth.openai.com/a', 'https://auth.openai.com.evil.test/a', 'https://other.test/a',
    'https://name:secret@auth.openai.com/a', 'https://auth.openai.com:123/a', 'javascript:alert(1)', 'invalid']) {
    authUrl = value;
    await assert.rejects(f.call({ action: 'accountLogin' }), { code: 'CODEX_MULTI_TAB_RPC_FAILED' });
  }
});

test('切换前检查全连接加载会话分页且不读取正文', async t => {
  const f = fixture(t, (method, params) => method === 'thread/loaded/list'
    ? params.cursor ? { data: ['other-project'], nextCursor: null } : { data: ['visible'], nextCursor: 'page-2' }
    : { thread: { id: params.threadId, status: { type: 'idle' } } });
  assert.equal((await f.call({ action: 'accountSwitchPreflight' })).safe, true);
  assert.equal(f.sent.filter(request => request.method === 'thread/loaded/list').length, 2);
  const reads = f.sent.filter(request => request.method === 'thread/read');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(request => request.params.includeTurns === false));
  assert.ok(reads.some(request => request.params.threadId === 'other-project'));
});

test('active、未知或错误状态、RPC失败、重复分页均拒绝切换', async t => {
  for (const type of ['active', 'systemError', 'unknown', undefined]) {
    const f = fixture(t, (method, params) => method === 'thread/loaded/list'
      ? { data: ['thread-a'] } : { thread: { id: params.threadId, status: { type } } });
    assert.equal((await f.call({ action: 'accountSwitchPreflight' })).safe, false);
  }
  for (const respond of [() => ({ data: ['a'], nextCursor: 'loop' }), () => ({ data: ['../invalid'] }),
    () => ({ data: [], nextCursor: 3 }), () => { throw new Error('private-secret'); }]) {
    const f = fixture(t, respond);
    const result = await f.call({ action: 'accountSwitchPreflight' });
    assert.equal(result.safe, false);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
  }
});

test('检查期间其他会话开始运行或检查超时拒绝切换', async t => {
  const f = fixture(t, () => {
    f.notify({ method: 'turn/started', params: { threadId: 'not-visible', turn: { id: 'turn-one', status: 'inProgress' } } });
    return { data: [] };
  });
  assert.equal((await f.call({ action: 'accountSwitchPreflight' })).safe, false);
  const timeout = fixture(t, () => undefined, 10);
  assert.equal((await timeout.call({ action: 'accountSwitchPreflight' })).safe, false);
});
