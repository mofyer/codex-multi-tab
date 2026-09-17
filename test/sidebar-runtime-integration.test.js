'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidebarController } = require('../src/sidebar/sidebar-controller');
const { registerSidebarBridge } = require('../src/compatibility/sidebar-bridge-patch');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** 真正串联控制器与桥，只替换官方传输；不向任何真实任务发送中断。 */
function fixture(t) {
  let callbacks, command, workspaceListener, pause;
  const calls = [], states = [];
  const host = { editorPanels: new Map(), isPanelAlive: () => false,
    codexMcpConnection: {
      registerProvider(_name, handlers) { callbacks = handlers; return { dispose() {} }; },
      abandonRequest() {},
      sendRequest(_provider, id, method, params) {
        calls.push({ method, params });
        const thread = { id: 'one', name: '模拟执行任务', cwd: '/project', status: { type: 'active' } };
        const responses = {
          'account/read': { account: null },
          'thread/list': { data: [thread], nextCursor: null },
          'thread/read': { thread },
          'thread/turns/list': { data: [{ id: 'turn-one', status: 'inProgress', items: [] }] },
          'turn/interrupt': {},
        };
        const gate = pause?.method === method ? pause : undefined;
        if (gate) { pause = undefined; gate.started.resolve(); }
        void (async () => {
          if (gate) await gate.release.promise;
          callbacks.onResult({ id, result: responses[method] });
        })();
      },
    },
  };
  const vscode = {
    extensions: { getExtension: () => ({ activate: async () => undefined }) },
    commands: {
      registerCommand(_name, handler) { command = handler; return { dispose() {} }; },
      getCommands: async () => ['codexMultiTab.internalBridge'],
      executeCommand: async (_name, args) => command(args),
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/project' } }],
      onDidChangeWorkspaceFolders(handler) { workspaceListener = handler; return { dispose() {} }; },
    },
    window: { showInformationMessage: async () => {}, showErrorMessage: async () => {} },
  };
  const context = { subscriptions: [] };
  const bridge = registerSidebarBridge(host, vscode, context, async () => ({ threadIds: [] }));
  const app = createSidebarController(vscode, context, { postState: state => states.push(state),
    openNewTab: async () => {}, openThreadTab: async () => {},
    timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
  t.after(() => { app.dispose(); bridge.dispose(); });
  return { app, calls, states,
    pause(method) { const gate = { method, started: deferred(), release: deferred() }; pause = gate; return gate; },
    changeWorkspace() { vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: '/other' } }]; return workspaceListener(); },
  };
}

for (const boundary of ['dispose', 'workspace']) {
  for (const phase of ['thread/read', 'thread/turns/list']) {
    test(`真实控制器和桥：停止准备的 ${phase} 期间 ${boundary} 不发送中断`, async t => {
      const f = fixture(t);
      await f.app.handleMessage({ type: 'ready' });
      assert.equal(f.states.at(-1).threads.items[0].runningTurnId, 'turn-one');
      // 跳过控制器的第一层目录核验，把 gate 放在桥内部准备阶段。
      const prepared = f.pause(phase);
      if (phase === 'thread/read') {
        // 第一层也被暂停时先释放，再在同一微任务链开始前设置下一次暂停。
        const stop = f.app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-one' });
        await prepared.started.promise;
        const actual = f.pause(phase); prepared.release.resolve();
        await actual.started.promise;
        if (boundary === 'dispose') f.app.dispose(); else await f.changeWorkspace();
        actual.release.resolve(); await stop;
      } else {
        const stop = f.app.handleMessage({ type: 'stopThread', threadId: 'one', turnId: 'turn-one' });
        await prepared.started.promise;
        if (boundary === 'dispose') f.app.dispose(); else await f.changeWorkspace();
        prepared.release.resolve(); await stop;
      }
      assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 0);
    });
  }
}
