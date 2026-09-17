'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSidebarController } = require('../src/sidebar/sidebar-controller');
const { registerSidebarBridge } = require('../src/compatibility/sidebar-bridge-patch');

// Synthetic JWTs and an isolated temporary home: never inspect a user's auth.json.
function credentials(email, accountId, suffix) {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' } };
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`,
    access_token: `integration-access-${suffix}`, refresh_token: `integration-refresh-${suffix}`, account_id: accountId,
  }, last_refresh: '2026-09-17T00:00:00Z' });
}

test('真实侧栏、桥与凭据存储：保存A/B、保留B最新token、切换重载及身份验收完整链路', { timeout: 10000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-account-flow-'));
  const authPath = path.join(home, 'auth.json');
  const secretValues = new Map(), globalValues = new Map(), intervals = new Set();
  const instances = [], states = [], calls = [], errors = [], commands = new Map();
  const accountA = { type: 'chatgpt', email: 'a@example.test', accountId: 'workspace-a', planType: 'pro' };
  const accountB = { type: 'chatgpt', email: 'b@example.test', accountId: 'workspace-b', planType: 'pro' };
  const authA = credentials(accountA.email, accountA.accountId, 'a-initial');
  const authB = credentials(accountB.email, accountB.accountId, 'b-initial');
  const authBLatest = credentials(accountB.email, accountB.accountId, 'b-refreshed');
  let officialAccount = accountA, reloads = 0;
  const context = {
    subscriptions: [],
    secrets: { async get(key) { return secretValues.get(key); }, async store(key, value) { secretValues.set(key, value); } },
    globalState: { get(key) { return globalValues.get(key); }, async update(key, value) {
      if (value === undefined) globalValues.delete(key); else globalValues.set(key, value);
    } },
  };
  const timers = {
    setInterval(callback) { const timer = { callback, unref() {} }; intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
  };
  const vscode = {
    env: {},
    extensions: { getExtension: () => ({ activate: async () => undefined }) },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return { dispose() {
        if (commands.get(name) === handler) commands.delete(name);
      } }; },
      async getCommands() { return [...commands.keys()]; },
      async executeCommand(name, request) {
        if (name === 'workbench.action.reloadWindow') { reloads++; return; }
        assert.ok(commands.has(name), `Unexpected command ${name}`);
        return commands.get(name)(request);
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: home } }],
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
    },
    window: { async showErrorMessage(message) { errors.push(message); }, async showInformationMessage() {} },
  };
  function start() {
    let callbacks;
    const host = {
      appServerClient: {
        isLocal: true, runsInsideWsl: false, hostConfig: { id: 'local', kind: 'local' },
        async codexHome() { return home; }, async platformPath() { return path; },
      },
      editorPanels: new Map(), isPanelAlive: () => false, globalState: context.globalState,
      codexMcpConnection: {
        registerProvider(_name, handlers) { callbacks = handlers; return { dispose() {} }; },
        abandonRequest() {},
        sendRequest(_provider, id, method, params) {
          calls.push({ method, params });
          const results = {
            'config/read': { config: { cli_auth_credentials_store: 'file' } },
            'account/read': { account: { type: 'chatgpt', email: officialAccount.email, planType: officialAccount.planType } },
            'account/rateLimits/read': { accountId: officialAccount.accountId, rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
            } },
            'thread/list': { data: [], nextCursor: null },
            'thread/loaded/list': { data: [], nextCursor: null },
          };
          assert.ok(Object.hasOwn(results, method), `Unexpected RPC ${method}`);
          queueMicrotask(() => callbacks.onResult({ id, result: results[method] }));
        },
      },
    };
    const bridge = registerSidebarBridge(host, vscode, context, async () => ({ threadIds: [] }), 1000);
    // Default accountStoreFactory is deliberately retained: this runs the actual store.
    const controller = createSidebarController(vscode, context, { postState: state => states.push(state),
      openNewTab: async () => {}, openThreadTab: async () => {}, timers });
    const instance = { controller, bridge, dispose() { controller.dispose(); bridge.dispose(); } };
    instances.push(instance);
    return instance;
  }
  t.after(async () => {
    for (const instance of instances) instance.dispose();
    await fs.rm(home, { recursive: true, force: true });
  });
  const latest = () => states.at(-1);
  // Legal non-auth multiline settings must not disable accounts. The official merged
  // configuration above, rather than a homegrown TOML parser, decides storage support.
  await fs.writeFile(path.join(home, 'config.toml'), 'notify = [\n  "node",\n  "notify.js",\n]\n');
  await fs.writeFile(authPath, authA, { mode: 0o600 });
  const first = start();
  await first.controller.handleMessage({ type: 'ready' });
  assert.equal(latest().accounts.supported, true);
  await first.controller.handleMessage({ type: 'saveAccount' });
  assert.equal(latest().accounts.items.length, 1);
  const savedA = latest().accounts.items.find(item => item.email === accountA.email);
  assert.equal(savedA.isCurrent, true);

  await fs.writeFile(authPath, authB);
  officialAccount = accountB;
  await first.controller.handleMessage({ type: 'refresh' });
  await first.controller.handleMessage({ type: 'saveAccount' });
  assert.equal(latest().accounts.items.length, 2);
  assert.equal(latest().accounts.items.find(item => item.email === accountB.email).isCurrent, true);

  // The active account refreshes after its last explicit save; switching must preserve it.
  await fs.writeFile(authPath, authBLatest);
  await first.controller.handleMessage({ type: 'switchAccount', accountId: savedA.id });
  assert.equal(reloads, 1);
  assert.equal(await fs.readFile(authPath, 'utf8'), authA);
  assert.equal(secretValues.size, 1);
  const vault = JSON.parse([...secretValues.values()][0]);
  assert.equal(vault.profiles.length, 2);
  assert.equal(vault.profiles.find(profile => profile.id === savedA.id).auth, authA);
  assert.ok(vault.profiles.some(profile => profile.auth === authBLatest));
  assert.equal(globalValues.get('codexMultiTab.pendingAccountSwitch').id, savedA.id);
  if (process.platform !== 'win32') assert.equal((await fs.stat(authPath)).mode & 0o777, 0o600);

  first.dispose();
  assert.equal(intervals.size, 0);
  officialAccount = accountA;
  const reloaded = start();
  await reloaded.controller.handleMessage({ type: 'ready' });
  assert.equal(latest().accounts.items.find(item => item.id === savedA.id).isCurrent, true);
  assert.equal(latest().accounts.items.filter(item => item.isCurrent).length, 1);
  assert.equal(globalValues.has('codexMultiTab.pendingAccountSwitch'), false);
  assert.match(latest().accounts.message, /账号已切换/);
  assert.equal(latest().account.email, accountA.email);
  assert.equal(reloads, 1);
  assert.deepEqual(errors, []);
  assert.ok(calls.filter(call => call.method === 'thread/loaded/list').length >= 3);
  assert.deepEqual((await fs.readdir(home)).sort(), ['auth.json', 'config.toml']);
  const webviewPayload = JSON.stringify(states);
  for (const raw of [authA, authB, authBLatest]) {
    for (const token of Object.values(JSON.parse(raw).tokens).filter(value => value.startsWith('integration-') || value.endsWith('.synthetic'))) {
      assert.equal(webviewPayload.includes(token), false);
    }
  }
  assert.equal(webviewPayload.includes('refresh_token'), false);
  assert.equal(webviewPayload.includes('access_token'), false);
});
