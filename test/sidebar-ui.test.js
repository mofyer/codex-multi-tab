'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/sidebar.js'), 'utf8'), {
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
