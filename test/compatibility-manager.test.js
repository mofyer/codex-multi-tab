'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCompatibilityManager } = require('../compatibility-manager');

function setup(patcher, initial = { extensionPath: '/official/v1', packageJSON: { version: '1' } }) {
  let official = initial;
  let changed;
  let listenerDisposed = false;
  const warnings = [];
  const notices = [];
  const commands = [];
  let answer;
  const vscode = {
    extensions: {
      getExtension: () => official,
      onDidChange(callback) {
        changed = callback;
        return { dispose() { listenerDisposed = true; } };
      },
    },
    window: {
      showWarningMessage: async message => { warnings.push(message); },
      showInformationMessage: async (message, button) => { notices.push({ message, button }); return answer; },
    },
    commands: { executeCommand: async command => { commands.push(command); } },
  };
  const manager = createCompatibilityManager(vscode, { globalStorageUri: { fsPath: '/persistent/helper' } }, patcher);
  return {
    manager, warnings, notices, commands,
    change(value) { official = value; return changed(); },
    setAnswer(value) { answer = value; },
    get listenerDisposed() { return listenerDisposed; },
  };
}

test('激活自动检查和应用，使用持久备份，不自动重载', async () => {
  const calls = [];
  let applied = false;
  const state = setup((directory, action, backupRoot) => {
    calls.push({ directory, action, backupRoot });
    if (action === 'apply') applied = true;
    return { status: applied ? 'already-applied' : 'ready' };
  });
  await state.manager.requestCheck();
  assert.equal(calls.filter(call => call.action === 'apply').length, 1);
  assert.ok(calls.every(call => call.directory === '/official/v1' && call.backupRoot === '/persistent/helper/patch-backups'));
  assert.equal(state.notices.length, 1);
  assert.deepEqual(state.commands, []);
  assert.match(state.notices[0].message, /任务结束后重载/);
  state.manager.dispose();
});

test('已应用保持原样；缺失官方扩展不提示，安装后按真实路径检查', async () => {
  const calls = [];
  const state = setup((directory, action) => { calls.push({ directory, action }); return { status: 'already-applied' }; }, null);
  await state.manager.requestCheck();
  assert.deepEqual(calls, []);
  await state.change({ extensionPath: '/official/v2', packageJSON: { version: '2' } });
  assert.deepEqual(calls, [{ directory: '/official/v2', action: 'dry-run' }]);
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(state.notices, []);
  state.manager.dispose();
});

test('未知版本和哈希不恢复或应用，同路径版本同错误只提示一次', async () => {
  const calls = [];
  const state = setup((directory, action) => { calls.push(action); throw new Error('官方文件哈希不匹配'); });
  await state.manager.requestCheck();
  await state.manager.requestCheck();
  assert.ok(calls.every(action => action === 'dry-run'));
  assert.equal(state.warnings.length, 1);
  await state.change({ extensionPath: '/official/v2', packageJSON: { version: '2' } });
  assert.equal(state.warnings.length, 2);
  state.manager.dispose();
});

test('仅明确旧补丁错误允许校验恢复再应用', async () => {
  const actions = [];
  let restored = false;
  let applied = false;
  const state = setup((_directory, action) => {
    actions.push(action);
    if (action === 'restore') { restored = true; return { status: 'restored' }; }
    if (!restored) throw Object.assign(new Error('需要重新应用'), { code: 'CODEX_MULTI_TAB_REAPPLY_REQUIRED' });
    if (action === 'apply') applied = true;
    return { status: applied ? 'already-applied' : 'ready' };
  });
  await state.manager.requestCheck();
  assert.deepEqual(actions.slice(0, 4), ['dry-run', 'restore', 'dry-run', 'apply']);
  assert.equal(state.notices.length, 1);
  assert.deepEqual(state.warnings, []);
  state.manager.dispose();
});

test('恢复验证失败不继续应用，也不反复通知', async () => {
  const actions = [];
  const state = setup((_directory, action) => {
    actions.push(action);
    if (action === 'dry-run') throw Object.assign(new Error('旧补丁'), { code: 'CODEX_MULTI_TAB_REAPPLY_REQUIRED' });
    throw new Error('备份内容校验失败');
  });
  await state.manager.requestCheck();
  await state.manager.requestCheck();
  assert.ok(!actions.includes('apply'));
  assert.equal(state.warnings.length, 1);
  state.manager.dispose();
});

test('并发更新串行化，下一轮读取更新后的官方安装路径', async () => {
  let release;
  let active = 0;
  let maxActive = 0;
  const paths = [];
  const state = setup(async directory => {
    paths.push(directory);
    active++;
    maxActive = Math.max(maxActive, active);
    if (paths.length === 1) await new Promise(resolve => { release = resolve; });
    active--;
    return { status: 'already-applied' };
  });
  const next = state.change({ extensionPath: '/official/v2', packageJSON: { version: '2' } });
  state.manager.requestCheck();
  state.manager.requestCheck();
  release();
  await next;
  assert.equal(maxActive, 1);
  assert.deepEqual(paths, ['/official/v1', '/official/v2']);
  state.manager.dispose();
});

test('停用释放监听，未完成检查不得接着应用或通知', async () => {
  let release;
  const actions = [];
  const state = setup((_directory, action) => {
    actions.push(action);
    return new Promise(resolve => { release = resolve; });
  });
  const pending = state.manager.requestCheck();
  state.manager.dispose();
  release({ status: 'ready' });
  await pending;
  await state.manager.requestCheck();
  assert.equal(state.listenerDisposed, true);
  assert.deepEqual(actions, ['dry-run']);
  assert.deepEqual(state.notices, []);
});

test('只有用户点击提示按钮才重载', async () => {
  let release;
  let applied = false;
  const state = setup((_directory, action) => {
    if (action === 'apply') { applied = true; return { status: 'applied' }; }
    if (applied) return { status: 'already-applied' };
    return new Promise(resolve => { release = resolve; });
  });
  state.setAnswer('重载窗口');
  const pending = state.manager.requestCheck();
  release({ status: 'ready' });
  await pending;
  await Promise.resolve();
  assert.deepEqual(state.commands, ['workbench.action.reloadWindow']);
  state.manager.dispose();
});

test('跨窗口锁忙时延迟重试，事件风暴不会提前穿透等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = setup(() => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('忙'), { code: 'CODEX_MULTI_TAB_PATCH_BUSY' });
    return { status: 'already-applied' };
  });
  await state.manager.requestCheck();
  await Promise.all(Array.from({ length: 20 }, () => state.manager.requestCheck()));
  assert.equal(attempts, 1);
  assert.deepEqual(state.warnings, []);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.deepEqual(state.warnings, []);
  state.manager.dispose();
});

test('锁忙最多重试五次，耗尽只提示一次，新版本可以重新检查', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = setup(() => {
    attempts++;
    throw Object.assign(new Error('忙'), { code: 'CODEX_MULTI_TAB_PATCH_BUSY' });
  });
  await state.manager.requestCheck();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await state.manager.requestCheck();
  }
  assert.equal(attempts, 6);
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /稍后重载窗口重新检查/);
  t.mock.timers.tick(10000);
  await Promise.all(Array.from({ length: 20 }, () => state.manager.requestCheck()));
  assert.equal(attempts, 6);
  assert.equal(state.warnings.length, 1);
  await state.change({ extensionPath: '/official/v2', packageJSON: { version: '2' } });
  assert.equal(attempts, 7);
  assert.equal(state.warnings.length, 1);
  state.manager.dispose();
});

test('停用清理锁忙重试计时器，不再检查或显示提示', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = setup(() => {
    attempts++;
    throw Object.assign(new Error('忙'), { code: 'CODEX_MULTI_TAB_PATCH_BUSY' });
  });
  await state.manager.requestCheck();
  state.manager.dispose();
  t.mock.timers.tick(10000);
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.deepEqual(state.warnings, []);
});
