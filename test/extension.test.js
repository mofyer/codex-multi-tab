'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const { activate } = require('../extension');

/** 在注册时注入 VS Code 替身，回调保留各测试独立的接口实例。 */
function setup({ missing = false, activationError, openError } = {}) {
  const callbacks = new Map();
  const calls = [];
  const errors = [];
  const vscode = {
    Uri: { from: (parts) => ({ ...parts }) },
    ViewColumn: { Active: -1, Beside: -2 },
    extensions: {
      getExtension(id) {
        assert.equal(id, 'openai.chatgpt');
        return missing ? undefined : {
          async activate() {
            calls.push({ activation: true });
            if (activationError) throw activationError;
          },
        };
      },
    },
    commands: {
      registerCommand(id, callback) {
        callbacks.set(id, callback);
        return { dispose() { callbacks.delete(id); } };
      },
      async executeCommand(...args) {
        calls.push({ args });
        if (openError) throw openError;
      },
    },
    window: { async showErrorMessage(message) { errors.push(message); } },
  };
  const originalLoad = Module._load;
  const context = { subscriptions: [] };
  try {
    Module._load = function (id, ...args) {
      return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args);
    };
    activate(context);
  } finally {
    Module._load = originalLoad;
  }
  return { callbacks, calls, errors, context };
}

test('连续与并发新建均使用不同 URI，保留官方路由并固定标签', async () => {
  const { callbacks, calls, errors } = setup();
  const open = callbacks.get('codexMultiTab.newTab');
  await open();
  await Promise.all([open(), open()]);
  const requests = calls.filter((call) => call.args).map((call) => call.args);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((args) => args[1].query)).size, 3);
  for (const [command, uri, editor, options] of requests) {
    assert.equal(command, 'vscode.openWith');
    assert.equal(editor, 'chatgpt.conversationEditor');
    assert.equal(uri.scheme, 'openai-codex');
    assert.equal(uri.authority, 'route');
    assert.equal(uri.path, '/extension/panel/new');
    assert.match(uri.query, /^codexMultiTab=[0-9a-f-]{36}$/);
    assert.deepEqual(options, { viewColumn: -1, preserveFocus: false, preview: false });
  }
  assert.deepEqual(errors, []);
});

test('右侧新建请求分屏，并先激活官方扩展', async () => {
  const { callbacks, calls } = setup();
  await callbacks.get('codexMultiTab.newTabBeside')();
  assert.deepEqual(calls[0], { activation: true });
  assert.equal(calls[1].args[3].viewColumn, -2);
});

test('缺少官方扩展时提示安装，不执行打开', async () => {
  const { callbacks, calls, errors } = setup({ missing: true });
  await callbacks.get('codexMultiTab.newTab')();
  assert.deepEqual(calls, []);
  assert.match(errors[0], /安装并启用官方 Codex/);
});

test('官方激活失败时显示错误，不执行打开', async () => {
  const { callbacks, calls, errors } = setup({ activationError: new Error('激活失败') });
  await callbacks.get('codexMultiTab.newTab')();
  assert.equal(calls.filter((call) => call.args).length, 0);
  assert.match(errors[0], /激活失败/);
});

test('官方编辑器不可用时显示错误', async () => {
  const { callbacks, errors } = setup({ openError: new Error('编辑器未注册') });
  await callbacks.get('codexMultiTab.newTab')();
  assert.match(errors[0], /编辑器未注册/);
});

test('停用时释放全部命令', () => {
  const { context, callbacks } = setup();
  assert.equal(callbacks.size, 2);
  context.subscriptions.forEach((subscription) => subscription.dispose());
  assert.equal(callbacks.size, 0);
});

test('按钮与快捷键引用已注册的命令，声明官方依赖', () => {
  const manifest = require('../package.json');
  const { callbacks } = setup();
  assert.deepEqual(manifest.extensionDependencies, ['openai.chatgpt']);
  for (const command of manifest.contributes.commands) assert.ok(callbacks.has(command.command));
  for (const items of Object.values(manifest.contributes.menus)) {
    for (const item of items) assert.ok(callbacks.has(item.command));
  }
  for (const item of manifest.contributes.keybindings) assert.ok(callbacks.has(item.command));
});
