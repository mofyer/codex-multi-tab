'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createSidebarViewProvider } = require('../src/sidebar/sidebar-view');

test('侧栏引用的脚本和样式真实存在，且资源授权仅覆盖侧栏目录', () => {
  const extensionUri = path.resolve(__dirname, '..');
  const resources = [];
  const webview = {
    cspSource: 'vscode-webview:',
    asWebviewUri(uri) { resources.push(uri); return `vscode-webview:${uri}`; },
    onDidReceiveMessage() { return { dispose() {} }; },
  };
  const provider = createSidebarViewProvider({ Uri: { joinPath: path.join } }, { extensionUri }, () => {});
  try {
    provider.resolveWebviewView({ webview, onDidDispose() { return { dispose() {} }; } });
    assert.equal(webview.options.enableScripts, true);
    assert.deepEqual(webview.options.localResourceRoots, [path.join(extensionUri, 'media/sidebar')]);
    assert.equal(resources.length, 2);
    for (const resource of resources) {
      assert.equal(fs.statSync(resource).isFile(), true);
      assert.equal(path.dirname(resource), webview.options.localResourceRoots[0]);
      assert.ok(webview.html.includes(`vscode-webview:${resource}`));
    }
    assert.match(webview.html, /Content-Security-Policy/);
    assert.match(webview.html, /script-src 'nonce-/);
  } finally {
    provider.dispose();
  }
});

// 执行真实侧栏脚本，只替换浏览器 DOM 和 VS Code 消息边界。
function sidebar() {
  const listeners = {};
  const messages = [];
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.events = {}; this.attributes = {};
      this.dataset = {}; this.style = {}; this.value = ''; this.className = ''; this.textContent = '';
      this.classList = {
        toggle: (name, enabled) => { const names = new Set(this.className.split(' ')); enabled ? names.add(name) : names.delete(name); this.className = [...names].join(' '); },
        remove: (name) => this.classList.toggle(name, false),
      };
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; this.append(...children); }
    remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = undefined; }
    setAttribute(name, value) { this.attributes[name] = value; if (name === 'class') this.className = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
    emit(type, fields = {}) { if (type === 'click' && this.disabled) return; const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...fields }; for (const handler of this.events[type] || []) handler(event); return event; }
    focus() { document.activeElement = this; }
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get childElementCount() { return this.children.length; }
    getBoundingClientRect() { return { left: 8, bottom: 70, width: this.className === 'thread-menu' ? 150 : 196, height: this.className === 'thread-menu' ? 110 : 60 }; }
    querySelectorAll(selector) {
      const matches = (child) => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector;
      return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const body = new Element('body');
  const ids = new Map();
  document = {
    body, activeElement: body,
    createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    getElementById: (id) => { if (!ids.has(id)) { const item = new Element('div'); ids.set(id, item); body.append(item); } return ids.get(id); },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener: (type, handler) => { (listeners[`document:${type}`] ||= []).push(handler); },
  };
  const window = { innerWidth: 220, innerHeight: 500, scrollY: 0, scrollTo() {}, addEventListener: (type, handler) => { (listeners[type] ||= []).push(handler); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/sidebar/sidebar.js'), 'utf8'), {
    document, window, Date, console,
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) }),
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame: (callback) => callback(),
  });
  const emit = (type, event) => (listeners[type] || []).forEach((handler) => handler(event));
  return {
    document, messages, ids, emit,
    state: (items, capabilities = {}, extra = {}) => emit('message', { data: { type: 'state', state: { account: {}, usage: {}, credits: {}, threads: { items }, capabilities: { pin: true, open: true, stop: true, ...capabilities }, ...extra } } }),
    rows: () => body.querySelectorAll('.thread-row'),
    menu: () => body.querySelector('.thread-menu'),
  };
}

const entry = (fields = {}) => ({ id: 'thread-a', title: '任务', updatedAt: Date.now() / 1000, ...fields });

test('仅真实运行会话显示运行标志和停止按钮，打开状态不能代替运行状态', () => {
  const ui = sidebar();
  ui.state([entry({ isOpen: true }), entry({ id: 'b', isRunning: true, runningTurnId: 'turn-b' })]);
  const [idle, running] = ui.rows();
  assert.equal(idle.querySelector('.thread-running'), null);
  assert.equal(idle.querySelector('.thread-actions').children.length, 2);
  assert.equal(running.querySelector('.thread-running').getAttribute('aria-label'), '运行中');
  const stop = running.querySelector('.thread-actions').children[2];
  stop.emit('click');
  assert.deepEqual(ui.messages.at(-1), { type: 'stopThread', threadId: 'b', turnId: 'turn-b' });
});

test('未知 turn、无停止能力、停止中均禁用停止，右键状态同源', () => {
  for (const [fields, caps] of [[{ isRunning: true }, {}], [{ isRunning: true, runningTurnId: 't' }, { stop: false }], [{ isRunning: true, runningTurnId: 't', stopping: true }, {}]]) {
    const ui = sidebar(); ui.state([entry(fields)], caps);
    const row = ui.rows()[0];
    const stop = row.querySelector('.thread-actions').children[2];
    assert.equal(stop.disabled, true);
    stop.emit('click');
    row.emit('contextmenu', { clientX: 10, clientY: 20 });
    assert.equal(ui.menu().children[2].disabled, true);
    assert.equal(ui.menu().children[2].textContent, fields.stopping ? '停止中…' : '停止当前轮次');
    assert.equal(ui.messages.some((message) => message.type === 'stopThread'), false);
  }
});

test('右键菜单置顶、重命名与停止均发送正确目标并关闭', () => {
  for (const [index, type] of [[0, 'togglePin'], [1, 'renameThread'], [2, 'stopThread']]) {
    const ui = sidebar(); ui.state([entry({ isPinned: true, isRunning: true, runningTurnId: 'turn-a' })]);
    ui.rows()[0].emit('contextmenu', { clientX: 219, clientY: 499 });
    const menu = ui.menu();
    assert.equal(menu.children[0].textContent, '取消置顶');
    assert.equal(menu.style.left, '66px');
    assert.equal(menu.style.top, '386px');
    menu.children[index].emit('click');
    assert.equal(ui.menu(), null);
    assert.equal(ui.messages.at(-1).type, type);
    assert.equal(ui.messages.at(-1).threadId, 'thread-a');
  }
});

test('菜单外点击和 Escape 关闭，键盘能打开及导航，禁用项不可操作', () => {
  const ui = sidebar(); ui.state([entry()], { pin: false });
  const row = ui.rows()[0]; const open = row.querySelector('.thread-open');
  row.emit('keydown', { key: 'F10', shiftKey: true });
  assert.equal(ui.menu().children.length, 2);
  assert.equal(ui.document.activeElement.textContent, '重命名');
  ui.menu().emit('keydown', { key: 'ArrowDown' });
  assert.equal(ui.document.activeElement.textContent, '重命名');
  ui.emit('document:keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(ui.menu(), null);
  assert.equal(ui.document.activeElement, open);
  row.emit('contextmenu', { clientX: 0, clientY: 0 });
  ui.emit('document:pointerdown', { target: ui.document.body });
  assert.equal(ui.menu(), null);
});

test('账号刷新不重建会话或菜单，运行状态与停止权限变化关闭过时菜单并刷新', () => {
  const ui = sidebar(); const entries = [entry({ isRunning: true, runningTurnId: 'turn-a' })];
  ui.state(entries);
  const row = ui.rows()[0]; row.emit('contextmenu', { clientX: 20, clientY: 50 });
  const menu = ui.menu();
  ui.ids.get('search').focus();
  ui.state(JSON.parse(JSON.stringify(entries)), {}, { account: { email: 'updated@example.test' } });
  assert.equal(ui.rows()[0], row);
  assert.equal(ui.menu(), menu);
  assert.equal(ui.document.activeElement, ui.ids.get('search'));
  ui.state(entries, { stop: false });
  assert.notEqual(ui.rows()[0], row);
  assert.equal(ui.menu(), null);
  assert.equal(ui.rows()[0].querySelector('.thread-actions').children[2].disabled, true);
  ui.state([entry({ isRunning: false, runningTurnId: null })]);
  assert.equal(ui.rows()[0].querySelector('.thread-running'), null);
});


test('离开 webview 点击编辑器或外层空白时关闭菜单且不抢回焦点', () => {
  const ui = sidebar();
  ui.state([entry({ isRunning: true, runningTurnId: 'turn-a' })]);
  const row = ui.rows()[0];
  row.emit('contextmenu', { clientX: 20, clientY: 40 });
  assert.ok(ui.menu());
  ui.document.body.focus();
  ui.emit('blur', {});
  assert.equal(ui.menu(), null);
  assert.equal(ui.document.activeElement, ui.document.body);
  assert.equal(ui.messages.some((message) => message.type === 'stopThread'), false);
});

const accountsState = (fields = {}) => ({
  supported: true, busy: false, pendingLogin: false,
  items: [
    { id: 'account-a', label: '工作', email: 'work@example.test', planType: 'pro', isCurrent: true },
    { id: 'account-b', label: '个人', email: 'personal@example.test', planType: 'plus', isCurrent: false },
  ],
  ...fields,
});

test('账号入口与列表操作只发送对应命令和账号 ID', () => {
  const ui = sidebar();
  ui.state([], {}, { account: { status: 'ready' }, accounts: accountsState() });
  assert.equal(ui.ids.get('saved-accounts-heading').textContent, '已保存账号（2）');
  assert.equal(ui.ids.get('saved-accounts').hidden, false);
  for (const [id, type] of [['save-account', 'saveAccount'], ['add-account', 'addAccount']]) {
    ui.ids.get(id).emit('click');
    assert.deepEqual(ui.messages.at(-1), { type });
  }
  const rows = ui.document.querySelectorAll('.saved-account');
  assert.equal(rows[0].querySelector('.badge').textContent, '当前');
  assert.equal(rows[0].querySelector('button').disabled, true);
  assert.equal(rows[1].querySelector('.saved-account-plan').textContent, 'Plus');
  assert.match(rows[1].querySelector('button').title, /重载当前窗口/);
  for (const [index, type] of ['switchAccount', 'renameAccount', 'removeAccount'].entries()) {
    rows[1].querySelectorAll('button')[index].emit('click');
    assert.deepEqual(ui.messages.at(-1), { type, accountId: 'account-b' });
  }
});

test('账号操作中及登录中禁用账号操作和额度重置，登录中允许取消', () => {
  for (const accounts of [accountsState({ busy: true }), accountsState({ busy: true, pendingLogin: true }), accountsState({ pendingLogin: true })]) {
    const ui = sidebar();
    ui.state([], { reset: true }, {
      account: { status: 'ready' }, accounts,
      credits: { status: 'ready', items: [{ id: 'card', available: true }] },
    });
    const actions = [ui.ids.get('save-account'), ui.ids.get('add-account'), ui.ids.get('refresh'),
      ...ui.document.querySelectorAll('.saved-account').flatMap((row) => row.querySelectorAll('button')),
      ...ui.document.querySelectorAll('.reset-credit')];
    const before = ui.messages.length;
    for (const action of actions) { assert.equal(action.disabled, true); action.emit('click'); }
    assert.equal(ui.messages.length, before);
    const cancel = ui.ids.get('cancel-account-login');
    assert.equal(cancel.hidden, !accounts.pendingLogin);
    if (accounts.pendingLogin) {
      assert.equal(cancel.disabled, false);
      cancel.emit('click');
      assert.deepEqual(ui.messages.at(-1), { type: 'cancelAccountLogin' });
    }
  }
});

test('重置结束的宿主状态立即清除处理中并恢复账号操作和刷新', () => {
  const ui = sidebar();
  const extra = { account: { status: 'ready' }, accounts: accountsState(),
    credits: { status: 'ready', items: [{ id: 'card', available: true }] } };
  ui.state([], { reset: true }, extra);
  ui.document.querySelectorAll('.reset-credit')[0].emit('click');
  assert.deepEqual(ui.messages.at(-1), { type: 'resetCredit', creditId: 'card' });
  assert.equal(ui.document.querySelectorAll('.reset-credit')[0].textContent, '处理中');
  assert.equal(ui.ids.get('save-account').disabled, true);
  assert.equal(ui.ids.get('add-account').disabled, true);
  ui.state([], { reset: true }, { ...extra, credits: { ...extra.credits, busyId: 'card' } });
  assert.equal(ui.document.querySelectorAll('.reset-credit')[0].textContent, '处理中');
  assert.equal(ui.document.querySelectorAll('.saved-account')[1].querySelector('button').disabled, true);
  ui.state([], { reset: true }, { ...extra, credits: { status: 'ready', items: [{ id: 'card', available: false }] } });
  assert.equal(ui.document.querySelectorAll('.reset-credit')[0].textContent, '重置');
  assert.equal(ui.document.querySelectorAll('.reset-credit')[0].disabled, true, '已消费卡不能再消费');
  assert.equal(ui.ids.get('save-account').disabled, false);
  assert.equal(ui.ids.get('add-account').disabled, false);
  assert.equal(ui.document.querySelectorAll('.saved-account')[1].querySelector('button').disabled, false);
  assert.equal(ui.ids.get('refresh').disabled, false);
  ui.ids.get('refresh').emit('click');
  assert.deepEqual(ui.messages.at(-1), { type: 'refresh' });
  assert.equal(ui.messages.filter(value => value.type === 'resetCredit').length, 1);
});

test('不支持和旧版状态隐藏列表并解释原因，未登录仍可添加账号', () => {
  for (const accounts of [undefined, accountsState({ supported: false, message: '当前登录由系统钥匙串管理' })]) {
    const ui = sidebar(); ui.state([], {}, { accounts });
    assert.equal(ui.ids.get('save-account').disabled, true);
    assert.equal(ui.ids.get('add-account').disabled, true);
    assert.equal(ui.ids.get('saved-accounts').hidden, true);
    assert.equal(ui.ids.get('accounts-scope').hidden, true);
    assert.match(ui.ids.get('accounts-message').textContent, accounts ? /钥匙串/ : /暂不支持/);
  }
  const ui = sidebar(); ui.state([], {}, { account: { status: 'signed-out' }, accounts: accountsState({ items: [] }) });
  assert.equal(ui.ids.get('save-account').disabled, true);
  assert.equal(ui.ids.get('add-account').disabled, false);
  assert.match(ui.ids.get('account-list').querySelector('p').textContent, /尚未保存/);
});

test('账号数据作为文本显示且不将凭据渲染或发送到动作中', () => {
  const ui = sidebar();
  const payload = '<img src=x onerror=alert(1)>';
  ui.state([], {}, { accounts: accountsState({
    items: [{ id: 'account-x', email: payload, label: payload, planType: payload, token: 'secret-token', credentials: 'secret-credentials' }],
    message: payload,
  }) });
  const row = ui.document.querySelectorAll('.saved-account')[0];
  assert.equal(row.querySelector('strong').textContent, payload);
  assert.equal(row.querySelector('.muted').textContent, payload);
  assert.equal(ui.ids.get('accounts-message').textContent, payload);
  assert.equal(ui.document.querySelectorAll('img').length, 0);
  const allText = (element) => element.textContent + element.children.map(allText).join('');
  assert.doesNotMatch(allText(ui.document.body), /secret-token|secret-credentials/);
  row.querySelector('button').emit('click');
  assert.deepEqual(ui.messages.at(-1), { type: 'switchAccount', accountId: 'account-x' });
});

test('普通状态刷新保持账号按钮及焦点，列表变更后恢复对应操作焦点', () => {
  const ui = sidebar();
  ui.state([], {}, { accounts: accountsState() });
  const button = ui.document.querySelectorAll('.saved-account')[1].querySelectorAll('button')[1];
  button.focus();
  ui.state([], {}, { account: { email: 'changed@example.test' }, accounts: accountsState() });
  assert.equal(ui.document.activeElement, button);
  assert.equal(ui.document.querySelectorAll('.saved-account')[1].querySelectorAll('button')[1], button);
  const updated = accountsState(); updated.items[1].label = '新名称';
  ui.state([], {}, { accounts: updated });
  assert.equal(ui.document.activeElement.dataset.accountId, 'account-b');
  assert.equal(ui.document.activeElement.dataset.accountAction, 'renameAccount');
  assert.notEqual(ui.document.activeElement, button);
  ui.state([], {}, { accounts: accountsState({ busy: true }) });
  assert.equal(ui.document.activeElement, ui.ids.get('saved-accounts-heading'));
});

test('账号面板显示宿主提供的实际运行版本并区分开发模式', () => {
  const ui = sidebar();
  ui.state([], {}, { runtime: { version: '0.5.2', development: true } });
  assert.equal(ui.ids.get('runtime-version').textContent, '运行版本 0.5.2 · 开发模式');
  ui.state([], {}, { runtime: { version: '0.5.2', development: false } });
  assert.equal(ui.ids.get('runtime-version').textContent, '运行版本 0.5.2');
  ui.state([]);
  assert.equal(ui.ids.get('runtime-version').hidden, true);
});
