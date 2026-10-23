'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { getNativePatchFiles, getNativeDependencies } = require('../src/compatibility/native-history-patch');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const documentFor = route => ({ querySelector: () => ({ content: route }) });
function readOriginal(root, entry) {
  const bytes = fs.readFileSync(path.join(root, entry.file));
  if (hash(bytes) === entry.originalHash) return bytes.toString('utf8');
  const backupRoot = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/mofyer.codex-multi-tab/patch-backups');
  for (const directory of fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []) {
    const manifestFile = path.join(backupRoot, directory, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.root !== root) continue;
    const saved = manifest.files.find(file => file.file === entry.file);
    if (!saved) continue;
    const original = fs.readFileSync(path.join(backupRoot, directory, saved.backup));
    if (hash(original) === entry.originalHash) return original.toString('utf8');
  }
  throw new Error(`Missing audited original: ${entry.file}`);
}

function collect(tree, type, result = []) {
  if (Array.isArray(tree)) tree.forEach(child => collect(child, type, result));
  else if (tree && typeof tree === 'object') {
    if (tree.type === type) result.push(tree);
    collect(tree.props?.children, type, result);
  }
  return result;
}

for (const version of ['26.1007.21434', '26.51007.21434']) {
  let root = path.join(os.homedir(), `.vscode/extensions/openai.chatgpt-${version}-darwin-arm64`);
  const override = process.env.CODEX_MULTI_TAB_OFFICIAL_ROOT;
  if (override && JSON.parse(fs.readFileSync(path.join(override, 'package.json'), 'utf8')).version === version) root = override;
  test(`${version}: audited native row/menu, lazy init, header cache and blank-panel scope`, { skip: !fs.existsSync(root) }, () => {
    for (const entry of getNativeDependencies(version)) assert.equal(hash(fs.readFileSync(path.join(root, entry.file))), entry.originalHash);
    const patches = getNativePatchFiles(version);
    const [host, app, header, panel] = patches.map(entry => entry.transform(readOriginal(root, entry)));
    assert.match(host, /this\.broadcastPersistedAtomUpdate\(F,V\),F==="pinned-thread-ids"/);
    assert.ok(host.includes('})(this,je,e,r))break;let n=rF(r.path);'));
    assert.match(app, /gD=q\(Q,\(\)=>!1\)/);
    assert.match(app, /return hy\(e,hs.PINNED_THREAD_IDS\)/);
    assert.match(app, /mg\(`set-thread-pinned`,\{params:i\}\)/);
    assert.match(app, /queryKey:ug\(`list-pinned-threads`\),refetchType:`all`/);

    const initialized = [];
    const rowContext = {
      URLSearchParams, document: documentFor('/new?codexMultiTab=qa'),
      l$: () => initialized.push('native-row'), CE: () => initialized.push('native-pins'),
      K: atom => { assert.equal(atom, 'native-pins'); return ['first']; }, SE: 'native-pins',
      MFr: 'enhanced-native-row', Gjr: 'plain-native-row', c$: { jsx: (type, props) => ({ type, props }) },
    };
    vm.createContext(rowContext);
    vm.runInContext(app.slice(app.indexOf('function codexMultiTabHistoryInit()'), app.lastIndexOf('export{codexMultiTabHistoryRow')), rowContext);
    rowContext.codexMultiTabHistoryInit();
    assert.deepEqual(initialized, ['native-row', 'native-pins']);
    const onClick = () => {};
    const row = rowContext.codexMultiTabHistoryRow({ conversationId: 'first', onClick });
    assert.equal(row.type, 'enhanced-native-row');
    assert.equal(row.props.isPinned, true);
    assert.equal(row.props.onClick, onClick);
    rowContext.document = documentFor('/local/ordinary');
    assert.equal(rowContext.codexMultiTabHistoryRow({ conversationId: 'first' }).type, 'plain-native-row');

    // 执行生成的菜单分支，回调保留官方重命名与 pin API，不暴露桌面动作。
    const menuStart = app.indexOf('It=e=>{if(codexHistory)');
    const menuEnd = app.indexOf(';if($e.disabled', menuStart);
    const calls = [];
    const menuContext = {
      codexHistory: true, r: 'first', SE: 'native-pins', P: { get: () => ['first'] },
      CQ: ({ pin, rename }) => [rename, pin],
      OQ: ({ isPinned, onPinnedChange }) => ({ id: isPinned ? 'unpin-thread' : 'pin-thread', onSelect: () => onPinnedChange(!isPinned) }),
      wt: () => calls.push('rename'), zG: (scope, id, pinned) => calls.push({ id, pinned }),
    };
    const menu = vm.runInNewContext(`(${app.slice(menuStart + 3, menuEnd)};})()`, menuContext);
    assert.deepEqual(Array.from(menu, item => item.id), ['rename-thread', 'unpin-thread']);
    menu.forEach(item => item.onSelect());
    assert.deepEqual(calls, ['rename', { id: 'first', pinned: false }]);
    assert.match(app, /getMenuItems:codexHistory\|\|Bt/);
    assert.match(app, /Pt=async\(\)=>\{if\(codexHistory\)return;/);
    assert.match(header, /Dn=e\(\(\(\)=>\{codexMultiTabHistoryInit\(\),Cn=x\(\)/);

    // 执行整个实际转换后的官方 vn 组件，保留 compiler cache 跨渲染。
    const cache = Array(35).fill(Symbol.for('react.memo_cache_sentinel'));
    let pins = ['first', 'second'], active = 'first', filter = 'local', query = '';
    const jsx = (type, props) => ({ type, props });
    const context = {
      URLSearchParams, document: documentFor('/new?codexMultiTab=qa'),
      codexMultiTabPinnedIds: 'pins', Pt: 'filter', Ft: 'environment', Re: {},
      l: atom => atom === 'pins' ? pins : atom === 'filter' ? filter : null,
      Cn: { c: size => { assert.equal(size, 35); return cache; } },
      f: () => ({}), i: () => ({}), st: () => () => {}, se: () => ({ authMethod: 'chatgpt' }),
      y: () => ({ params: { conversationId: active } }), ce: () => ({ data: [] }), mt: () => false,
      un: () => true, fn: (tasks, conversations) => [...conversations.map(conversation => ({ kind: 'local', key: conversation.id, conversation })), ...(tasks ?? [])],
      wn: { useState: () => [query, () => {}], useDeferredValue: value => value },
      yn: item => item.kind === 'remote', _t: (title, text) => title.toLowerCase().includes(text), be: conversation => conversation.title,
      W: { Section: 'Section' }, Z: { jsx, jsxs: jsx, Fragment: 'Fragment' },
      Lt: 'Search', Qt: 'Filter', qt: 'Environment', Sn: 'Error', xn: 'Loading', on: 'NoMatch', Vt: 'Empty',
      Tn: 'LocalRow', En: 'RecentRow', Le: 'CloudRow', o: 'Text', ee: 'Button', ne: 'Spinner',
    };
    vm.createContext(context);
    vm.runInContext(header.slice(header.indexOf('function vn('), header.indexOf('function yn(')), context);
    const first = { id: 'first', title: 'First', hostId: 'local', updatedAt: 1 };
    const second = { id: 'second', title: 'Second', hostId: 'local', updatedAt: 2 };
    const props = { cloudtasksQuery: { data: [] }, localConversations: [first, second], onClose: () => {} };
    let tree = context.vn(props);
    let pinnedRows = collect(tree, 'RecentRow');
    assert.deepEqual(pinnedRows.map(row => row.props.item.conversation.id), ['first', 'second']);
    assert.equal(pinnedRows[0].props.isActive, true);
    assert.equal(collect(tree, 'Empty').length, 0);
    assert.equal(collect(tree, 'LocalRow').length, 0);
    // 同一 pins 引用，但活动会话、会话元数据、关闭回调均已变化。
    active = 'second';
    const close = () => {};
    tree = context.vn({ ...props, onClose: close, localConversations: [{ ...first, title: 'Renamed', updatedAt: 5 }, second] });
    pinnedRows = collect(tree, 'RecentRow');
    assert.equal(pinnedRows[0].props.item.conversation.title, 'Renamed');
    assert.equal(pinnedRows[0].props.isActive, false);
    assert.equal(pinnedRows[1].props.isActive, true);
    assert.equal(pinnedRows[0].props.onClose, close);
    pins = ['second'];
    tree = context.vn(props);
    assert.deepEqual(collect(tree, 'RecentRow').map(row => row.props.item.conversation.id), ['second']);
    assert.deepEqual(collect(tree, 'LocalRow').map(row => row.props.conversationId), ['first']);
    query = 'First';
    tree = context.vn(props);
    assert.equal(collect(tree, 'RecentRow').length, 0);
    assert.equal(collect(tree, 'LocalRow').length, 1);
    query = 'Second';
    tree = context.vn(props);
    assert.equal(collect(tree, 'RecentRow').length, 1);
    assert.equal(collect(tree, 'NoMatch').length, 0);
    query = ''; filter = 'cloud';
    tree = context.vn(props);
    assert.equal(collect(tree, 'RecentRow').length, 0);
    context.document = documentFor('/local/ordinary'); filter = 'local';
    tree = context.vn(props);
    assert.equal(collect(tree, 'RecentRow').length, 0);
    assert.equal(collect(tree, 'LocalRow').length, 2);
    const panelStart = panel.indexOf('children:[(') + 'children:['.length;
    const panelEnd = panel.indexOf(',f,C]', panelStart);
    const panelExpr = panel.slice(panelStart, panelEnd);
    for (const [route, expected] of [['/new?codexMultiTab=qa', 'native-header'], ['/new', null]]) {
      const result = vm.runInNewContext(panelExpr, { URLSearchParams, document: documentFor(route), F: { jsx }, CodexMultiTabNativeHeader: 'native-header' });
      assert.equal(result?.type ?? null, expected);
    }
  });
}
