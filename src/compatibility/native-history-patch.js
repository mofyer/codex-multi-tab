'use strict';

const PROFILES = {
  '26.5908.31748': {
    hostHash: '820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f',
    app: 'app-initial-972655adec02.js', appHash: '919609dae54b1918456a1039eef6146dee869ec86061b7e845bc919e6fdbb5d5',
    header: 'header-8aa6e5b9570e.js', headerHash: '25bac7842b7e789252aefe13cea23f9d01ffa2b9b80ac274ddad26443bfa8c50', headerWrapper: 'header-30e04c9cc1d7.js', wrapperHash: 'ebfb47fe073641ca89b34f239a81781d6433aad3e56886ea89632a2a2fc7c2a8',
    panel: 'new-thread-panel-page-7e59912e536c.js', panelHash: '9ded343b755f12b9985d876960888b57766db029ae287c62b0c719db7eab3b05', panelChildren: 'u,g',
    row: 's4t', rowInit: 'l4t', plainRow: 'pWt', jsx: 'VX', pins: 'Dw', pin: 'KH', menu: 'fX', pinItem: 'YY', rowKey: 'dw',
    headerRow: 'Te', section: 'He', recent: 'I', local: 'F', groupChildren: 'B,H,U', splitAnchor: ':D,L;', splitNext: 'L', emptyQuery: 'j',
  },
  '26.908.40401': {
    hostHash: '820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f',
    app: 'app-initial-a190b16fc630.js', appHash: '50b1a443400ba2f7ac0be53c56536a3e145bccfff0e2f456f100850133a01683',
    header: 'header-fc6d647f8f9f.js', headerHash: '8f7ef4b415a9dbad8ee0f61a1aef8ee5f5e6c5d668eff4b74a83e90911830d24', headerWrapper: 'header-94634dee8411.js', wrapperHash: '68ddf7103026745e3bdf9dc08cf624553bf536afcaea7e0738ae1d0445bc06bc',
    panel: 'new-thread-panel-page-a3f4089dcbc1.js', panelHash: '19dac9b6cd5539f9cf5f5a510bf7d7ad5c3c276e60f0a1c0cec7cacbcfb8707c', panelChildren: 'l,g',
    row: 'u4t', rowInit: 'f4t', plainRow: 'gWt', jsx: 'HX', pins: 'jw', pin: 'qH', menu: 'pX', pinItem: 'XY', rowKey: 'hw',
    headerRow: 'Ee', section: 'Ue', recent: 'P', local: 'N', groupChildren: 'B,V,H', splitAnchor: ':D,F;', splitNext: 'F', emptyQuery: 'A',
  },
  '26.917.61114': {
    hostHash: '2ac22107521c9e8fd1c907bc335bd3b0609c8d612bb2731e8bed6badda5d6f13',
    broadcast: 'this.broadcastPersistedAtomUpdate(se,ue)',
    navigation: 'case"navigate-in-new-editor-tab":{let n=hM(r.path);', vscode: 'qe',
    app: 'app-initial-801a1845d914.js', appHash: 'd9cbca4f44d7206d83bcd136f12400282e51cbae2cc8a147cb8b2412faa71eb4',
    header: 'header-700e6c0b65a7.js', headerHash: 'a9aa4ec7b73752818652f6c1aeae1786f42a943d6dd7dd4bb520c0ac6bc17f96',
    headerWrapper: 'header-4be255c13706.js', wrapperHash: '141554a2e896f9c08c56ddf976f094daf5138ab39773b938d0a247265f598eb8',
    panel: 'new-thread-panel-page-a121aa5c2554.js', panelHash: '3e915ac9950cdd218f2d30704404e93e08b748c381ae8e5697491c5123bb02a5', panelChildren: 'u,x', panelJsx: 'F',
    row: 'YBn', rowInit: 'QBn', plainRow: 'cPn', jsx: 'Z2', pins: 'Lw', rowHook: 'o',
    headerRow: 'tt', headerJsx: 'Z', headerHook: 'n', headerInitAnchor: 'Mn=e((()=>{On=S(),',
    headerLocalRow: '(0,Z.jsx)(tt,{conversationId:n,hostId:r,isActive:a,metaContent:c,onClick:o,onActiveArchiveStart:s})',
    headerRecentRow: '(0,Z.jsx)(tt,{conversationId:n.conversation.id,hostId:n.conversation.hostId,isActive:r,metaContent:e,onClick:a,onActiveArchiveStart:o})',
    section: 'te', recent: 'F', local: 'P', groupChildren: 're,ae,B',
    groupActive: 'b', groupClose: 'o', groupArchive: 'p', mode: 'y', splitAnchor: ':D,I;', splitNext: 'I', emptyQuery: 'j',
    localEmpty: 'P.length?P.map(e=>(0,Z.jsx)(An,{conversationId:e.id,hostId:e.hostId,updatedAt:e.recencyAt??e.updatedAt,isActive:b===e.id,onClose:o,onActiveArchiveStart:p},e.id)):j?',
  },
};

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('原生历史补丁特征不唯一或缺失，拒绝修改');
  return source.replace(anchor, () => replacement);
}

// 标记来自原始路由，切换会话后仍只增强辅助扩展创建的面板。
function isHelperDocument(doc = document) {
  const route = doc.querySelector('meta[name="initial-route"]')?.content;
  return typeof route === 'string' && route.includes('?')
    && !!new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('codexMultiTab');
}

// 只使用官方 persisted atom；队列覆盖完整的读取、修改、写入周期。
async function nativePinnedThreads(state, input) {
  return state.enqueueUpdate('codex-multi-tab-native-pin-operation', async () => {
    const record = await state.get('persisted-atom-state');
    const stored = record?.['pinned-thread-ids'];
    if (stored != null && (!Array.isArray(stored) || stored.some(id => typeof id !== 'string'))) {
      throw new Error('官方置顶会话数据格式无效');
    }
    const current = [...new Set(stored ?? [])];
    if (input == null) return { threadIds: current };
    const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
    if (!validId(input.threadId) || typeof input.pinned !== 'boolean'
      || (input.beforeThreadId != null && !validId(input.beforeThreadId))) {
      throw new Error('置顶会话参数无效');
    }
    const next = current.filter(id => id !== input.threadId);
    if (input.pinned) {
      const before = input.beforeThreadId == null ? -1 : next.indexOf(input.beforeThreadId);
      next.splice(before < 0 ? next.length : before, 0, input.threadId);
    }
    await state.updatePersistedAtomValue('pinned-thread-ids', next);
    return { success: true };
  });
}

// 来源面板在弹窗前固定；取消或面板关闭时都不导航，也不终止任何任务。
async function navigateHistoryInPlace(host, vscode, webview, message) {
  if (typeof message.path !== 'string' || !/^\/local\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/.test(message.path)) return false;
  const panel = host.findPanelByWebview(webview);
  const route = panel && host.editorPanels.get(panel)?.initialRoute;
  if (typeof route !== 'string' || !route.includes('?')
    || !new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('codexMultiTab')) return false;
  if (!host.isPanelAlive(panel)) return true;
  const choice = await vscode.window.showWarningMessage('切换会替换当前标签页的会话内容。请先保存未发送的内容。',
    { modal: true }, '继续切换');
  if (choice === '继续切换' && host.isPanelAlive(panel) && host.editorPanels.has(panel)) {
    host.sendMessageToPanel(panel, { type: 'navigate-to-route', path: message.path });
  }
  return true;
}

// 只在原生列表的已有本地会话中分出置顶项，不改变云端或待创建工作树行。
function partitionNativeHistory(items, conversations, pins, enabled) {
  if (!enabled) return { pinned: [], items, conversations };
  const ids = new Set(pins);
  const isPinned = item => item.kind === 'local' && item.conversation != null && ids.has(item.conversation.id);
  const candidates = new Map(items.filter(isPinned).map(item => [item.conversation.id, item]));
  for (const conversation of conversations) {
    if (ids.has(conversation.id) && !candidates.has(conversation.id)) {
      candidates.set(conversation.id, { kind: 'local', key: `codex-multi-tab-pin:${conversation.id}`, conversation });
    }
  }
  const pinned = pins.flatMap(id => candidates.has(id) ? [candidates.get(id)] : []);
  return { pinned, items: items.filter(item => !isPinned(item)), conversations: conversations.filter(item => !ids.has(item.id)) };
}

function transformNativeHost(source, profile) {
  const pins = '"list-pinned-threads":async()=>({threadIds:[]}),"set-thread-pinned":async()=>({success:!1})';
  source = replaceOnce(source, pins,
    `"list-pinned-threads":async()=>(${nativePinnedThreads.toString()})(this.globalState),"set-thread-pinned":async e=>(${nativePinnedThreads.toString()})(this.globalState,e)`);
  const broadcast = profile.broadcast ?? 'this.broadcastPersistedAtomUpdate(he,be)';
  source = replaceOnce(source, broadcast, `${broadcast},${profile.broadcast ? 'se' : 'he'}==="pinned-thread-ids"&&this.broadcastToAllViews({type:"pinned-threads-updated"})`);
  const navigation = profile.navigation ?? 'case"navigate-in-new-editor-tab":{let n=pI(r.path);';
  return replaceOnce(source, navigation,
    `case"navigate-in-new-editor-tab":{if(await (${navigateHistoryInPlace.toString()})(this,${profile.vscode ?? 'Ie'},e,r))break;${navigation.slice('case"navigate-in-new-editor-tab":{'.length)}`);
}

function transformNativeApp(source, profile) {
  const modern = profile.row === 'YBn';
  const rowProps = modern ? 'setPendingWorktreePinned:v,threadSummary:y,...b}=e,x='
    : 'setPendingWorktreePinned:_,threadSummary:v,...y}=e,b=';
  source = replaceOnce(source, rowProps, rowProps.replace(',...', ',codexMultiTabHistory:codexHistory,...'));
  // 复用官方菜单项与重命名对话框；不把桌面端其他能力暴露到 IDE。
  if (modern) {
    const menuAnchor = 'mt=e=>{let t=Cw(n);return ';
    source = replaceOnce(source, menuAnchor,
      'mt=e=>{if(codexHistory)return N2({pin:S2({isPinned:E.get(Lw).includes(n),onPinnedChange:e=>UB(E,n,e)}),rename:{id:`rename-thread`,onSelect:nt}});let t=Cw(n);return ');
    source = replaceOnce(source, 'getMenuItems:D?()=>ht(`row-actions`):void 0',
      'getMenuItems:D||codexHistory?()=>ht(`row-actions`):void 0');
  } else {
    const menuAnchor = `et=e=>{let t=${profile.rowKey}(n);return `;
    source = replaceOnce(source, menuAnchor,
      `et=e=>{if(codexHistory)return ${profile.menu}({pin:${profile.pinItem}({isPinned:T.get(${profile.pins}).includes(n),onPinnedChange:e=>${profile.pin}(T,n,e)}),rename:{id:\`rename-thread\`,onSelect:He}});let t=${profile.rowKey}(n);return `);
    source = replaceOnce(source, 'getMenuItems:E?()=>tt(`row-actions`):void 0', 'getMenuItems:E||codexHistory?()=>tt(`row-actions`):void 0');
  }
  const init = modern ? 'function codexMultiTabHistoryInit(){QBn();Rw()}' : '';
  const initExport = modern ? 'codexMultiTabHistoryInit' : `${profile.rowInit} as codexMultiTabHistoryInit`;
  const addition = `\n${init}\nfunction codexMultiTabHistoryRow(props){let pins=${profile.rowHook ?? 'vo'}(${profile.pins});let enhanced=(${isHelperDocument.toString()})();return(0,${profile.jsx}.jsx)(enhanced?${profile.row}:${profile.plainRow},enhanced?{...props,codexMultiTabHistory:true,isPinned:pins.includes(props.conversationId),canPin:true,showPinActionOnHover:true}:props)}\nexport{codexMultiTabHistoryRow,${initExport},${profile.pins} as codexMultiTabPinnedIds};\n`;
  return source + addition;
}

function transformNativeHeader(source, profile) {
  source = `import{codexMultiTabHistoryRow,codexMultiTabHistoryInit,codexMultiTabPinnedIds}from"./${profile.app}";\n` + source;
  const initAnchor = profile.headerInitAnchor ?? 'Mn=e((()=>{On=C(),';
  source = replaceOnce(source, initAnchor, initAnchor.replace('On=', 'codexMultiTabHistoryInit(),On='));
  const localRow = profile.headerLocalRow ?? `(0,Z.jsx)(${profile.headerRow},{conversationId:n,hostId:r,isActive:a,metaContent:c,onClick:o,onActiveArchiveStart:s})`;
  source = replaceOnce(source, localRow, localRow.replace(profile.headerRow, 'codexMultiTabHistoryRow'));
  const recentRow = profile.headerRecentRow ?? `(0,Z.jsx)(${profile.headerRow},{conversationId:n.conversation.id,hostId:n.conversation.hostId,isActive:r,metaContent:e,onClick:i,onActiveArchiveStart:a})`;
  source = replaceOnce(source, recentRow, recentRow.replace(profile.headerRow, 'codexMultiTabHistoryRow'));
  source = replaceOnce(source, 'function Cn(e){let t=', `function Cn(e){let codexPins=${profile.headerHook ?? 'b'}(codexMultiTabPinnedIds);let t=`);
  source = replaceOnce(source, profile.splitAnchor,
    `:D;let codexPartition=(${partitionNativeHistory.toString()})(${profile.recent},${profile.local},codexPins,(${isHelperDocument.toString()})()&&${profile.mode ?? 'v'}!==\`cloud\`);${profile.recent}=codexPartition.items;${profile.local}=codexPartition.conversations;let ${profile.splitNext};`);
  const jsx = profile.headerJsx ?? 'Z';
  const group = `(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[(0,${jsx}.jsx)(\`div\`,{className:\`px-[var(--padding-row-x)] py-1 text-sm text-tertiary\`,children:\`已置顶\`}),...codexPartition.pinned.map(item=>(0,${jsx}.jsx)(jn,{item,isActive:item.conversation.id===${profile.groupActive ?? 'y'},onClose:${profile.groupClose ?? 'i'},onActiveArchiveStart:${profile.groupArchive ?? 'm'}},item.key))]})`;
  source = replaceOnce(source, `children:[${profile.groupChildren}]`, `children:[codexPartition.pinned.length>0?${group}:null,${profile.groupChildren}]`);
  const localEmpty = profile.localEmpty ?? `${profile.local}.length?${profile.local}.map(e=>(0,Z.jsx)(An,{conversationId:e.id,hostId:e.hostId,updatedAt:e.recencyAt??e.updatedAt,isActive:y===e.id,onClose:i,onActiveArchiveStart:m},e.id)):${profile.emptyQuery}?`;
  source = replaceOnce(source, localEmpty, localEmpty.replace(`:${profile.emptyQuery}?`, `:codexPartition.pinned.length>0?null:${profile.emptyQuery}?`));
  source = replaceOnce(source, `${profile.recent}.length===0?${profile.emptyQuery}?`, `${profile.recent}.length===0?codexPartition.pinned.length>0?null:${profile.emptyQuery}?`);
  return source;
}

function transformNativePanel(source, profile) {
  const child = `children:[${profile.panelChildren}]`;
  return `import{Header as CodexMultiTabNativeHeader}from"./${profile.headerWrapper}";\n`
    + replaceOnce(source, child,
      `children:[(${isHelperDocument.toString()})()?(0,${profile.panelJsx ?? 'O'}.jsx)(CodexMultiTabNativeHeader,{}):null,${profile.panelChildren}]`);
}

function getNativePatchFiles(version) {
  const profile = PROFILES[version];
  if (!profile) throw new Error('此版本尚未审计原生历史补丁');
  return [
    { file: 'out/extension.js', originalHash: profile.hostHash, transform: source => transformNativeHost(source, profile) },
    { file: `webview/assets/${profile.app}`, originalHash: profile.appHash, transform: source => transformNativeApp(source, profile) },
    { file: `webview/assets/${profile.header}`, originalHash: profile.headerHash, transform: source => transformNativeHeader(source, profile) },
    { file: `webview/assets/${profile.panel}`, originalHash: profile.panelHash, transform: source => transformNativePanel(source, profile) },
  ];
}

function getNativeDependencies(version) {
  const profile = PROFILES[version];
  if (!profile) throw new Error('此版本尚未审计原生历史依赖');
  return [{ file: `webview/assets/${profile.headerWrapper}`, originalHash: profile.wrapperHash }];
}

module.exports = { getNativePatchFiles, getNativeDependencies, isHelperDocument, nativePinnedThreads, navigateHistoryInPlace, partitionNativeHistory };
