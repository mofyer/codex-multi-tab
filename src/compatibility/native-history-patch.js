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
  // This build is bridge/title audited, but its split native-history bundles
  // have not been audited yet. Keep the optional patch set empty until that
  // work is complete instead of applying an older row/header transform.
  '26.917.62051': { baseOnly: true },
  // The pinned-thread atom moved to a separate split chunk in these builds;
  // the row/header/panel bundles still need their own audit.
  '26.1002.51308': { baseOnly: true },
  '26.1007.21434': {
    splitHistory: true,
    hostHash: 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8',
    broadcast: 'this.broadcastPersistedAtomUpdate(F,V)', broadcastKey: 'F',
    navigation: 'case"navigate-in-new-editor-tab":{let n=rF(r.path);', vscode: 'je',
    app: 'app-initial-c014f9ee4429.js', appHash: 'aabbfa7c366706365a239b090ca1c657b6a0213d7287e54ef0a32d1b2e5ff6a0',
    header: 'header-57b689833777.js', headerHash: '622be3a466733cc74785df39c2fcad3005b288485538b14347a6573ebe098037',
    headerWrapper: 'header-906a88f614e6.js', wrapperHash: '933121d3eba6e95cdd27938e9c79a1f08e2eb947f23000dd1fa5eac1aa993061',
    panel: 'new-thread-panel-page-2f608bfe5aaf.js', panelHash: 'f5dc9c73cff588eb2f2c1382bc48e0774a200c5a398c7f2861cf770ad5a86d38', panelChildren: 'f,C', panelJsx: 'F',
    dependencies: [["app-initial-97d3534ad35f.js","47e9e488122cf37a6564ed57d11f499d9ac062b2e49db729091fe3c163a64b49"],["app-initial-7a199c66e670.js","59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26"]],
  },
  '26.51007.21434': {
    splitHistory: true,
    hostHash: 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8',
    broadcast: 'this.broadcastPersistedAtomUpdate(F,V)', broadcastKey: 'F',
    navigation: 'case"navigate-in-new-editor-tab":{let n=rF(r.path);', vscode: 'je',
    app: 'app-initial-41ab338a184f.js', appHash: 'c755dbca916c0f830a554fe2e3057f8642b32394bea7701338e5d506f692ad56',
    header: 'header-4afcdefd370e.js', headerHash: '022eaeedf487b166d532b322e83367ac42364728e12a46971a32f80aaa77beda',
    headerWrapper: 'header-5c55f78da8da.js', wrapperHash: 'cb04a4904fbb05fd16bbeaa256f41fa4c909d006688480d968530c285bd6bd11',
    panel: 'new-thread-panel-page-5d143ae20d2e.js', panelHash: 'f9a43d18f38bcdf49bf196f252beac929768afeaf494e888b781d9f4c787f7a0', panelChildren: 'f,C', panelJsx: 'F',
    dependencies: [["app-initial-c4ebaa710049.js","50e2af3d8c3d0e3c52612beb2d95940cc818dfe979d6d85a9fa61af5526640bc"],["app-initial-fee819fe4f22.js","460201045b5f5a4255fda737c9baa4768367a973d735cb37f3467bfe6af95316"]],
  },
  // 26.1021 重写了历史面板分块和置顶查询（IDE 宿主不再提供置顶服务），待单独审计。
  '26.1021.22027': { baseOnly: true },
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
  source = replaceOnce(source, broadcast, `${broadcast},${profile.broadcastKey ?? (profile.broadcast ? 'se' : 'he')}==="pinned-thread-ids"&&this.broadcastToAllViews({type:"pinned-threads-updated"})`);
  const navigation = profile.navigation ?? 'case"navigate-in-new-editor-tab":{let n=pI(r.path);';
  return replaceOnce(source, navigation,
    `case"navigate-in-new-editor-tab":{if(await (${navigateHistoryInPlace.toString()})(this,${profile.vscode ?? 'Ie'},e,r))break;${navigation.slice('case"navigate-in-new-editor-tab":{'.length)}`);
}

function transformNativeApp(source, profile) {
  if (profile.splitHistory) return transformSplitNativeApp(source);
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

// 26.1007 / 26.51007 的原生行仍在入口块；状态运行时拆到依赖块。
// 使用官方 SE 查询派生状态和 zG 更新，保持侧栏与历史共用置顶数据。
function transformSplitNativeApp(source) {
  source = replaceOnce(source, 'setPendingWorktreePinned:C,threadSummary:w,...T}=e',
    'setPendingWorktreePinned:C,threadSummary:w,codexMultiTabHistory:codexHistory,...T}=e');
  source = replaceOnce(source, 'It=e=>{if($e.disabled===!0)',
    'It=e=>{if(codexHistory)return CQ({pin:OQ({isPinned:P.get(SE).includes(r),onPinnedChange:e=>zG(P,r,e)}),rename:{id:`rename-thread`,onSelect:wt}});if($e.disabled===!0)');
  source = replaceOnce(source, 'getMenuItems:Bt||$e.disabled===!0?()=>Lt(`row-actions`):void 0',
    'getMenuItems:codexHistory||Bt||$e.disabled===!0?()=>Lt(`row-actions`):void 0');
  // 不为 IDE 的有限菜单预加载桌面项目管理数据。
  source = replaceOnce(source, 'Pt=async()=>{await Promise.all([JMr(P),c?tut(P):void 0])}',
    'Pt=async()=>{if(codexHistory)return;await Promise.all([JMr(P),c?tut(P):void 0])}');
  return source + `\nfunction codexMultiTabHistoryInit(){l$();CE()}\nfunction codexMultiTabHistoryRow(props){let pins=K(SE);let enhanced=(${isHelperDocument.toString()})();return(0,c$.jsx)(enhanced?MFr:Gjr,enhanced?{...props,codexMultiTabHistory:true,isPinned:pins.includes(props.conversationId),canPin:true,showPinActionOnHover:true}:props)}\nexport{codexMultiTabHistoryRow,codexMultiTabHistoryInit,SE as codexMultiTabPinnedIds};\n`;
}

function transformSplitNativeHeader(source, profile) {
  source = `import{codexMultiTabHistoryRow,codexMultiTabHistoryInit,codexMultiTabPinnedIds}from"./${profile.app}";\n` + source;
  source = replaceOnce(source, 'Dn=e((()=>{Cn=x(),', 'Dn=e((()=>{codexMultiTabHistoryInit(),Cn=x(),');
  for (const anchor of [
    '(0,Z.jsx)(qe,{conversationId:n,hostId:r,isActive:a,metaContent:c,onClick:o,onActiveArchiveStart:s})',
    '(0,Z.jsx)(qe,{conversationId:n.conversation.id,hostId:n.conversation.hostId,isActive:r,metaContent:e,onClick:i,onActiveArchiveStart:a})',
  ]) source = replaceOnce(source, anchor, anchor.replace('(qe,', '(codexMultiTabHistoryRow,'));
  source = replaceOnce(source, 'function vn(e){let t=(0,Cn.c)(34),',
    'function vn(e){let codexPins=l(codexMultiTabPinnedIds);let t=(0,Cn.c)(35),');
  source = replaceOnce(source, ':O,L;',
    `:O;let codexPartition=(${partitionNativeHistory.toString()})(I,F,codexPins,(${isHelperDocument.toString()})()&&b!==\`cloud\`);I=codexPartition.items;F=codexPartition.conversations;let L;`);
  const group = '(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(`div`,{className:`px-[var(--padding-row-x)] py-1 text-sm text-tertiary`,children:`已置顶`}),...codexPartition.pinned.map(item=>(0,Z.jsx)(En,{item,isActive:item.conversation.id===x,onClose:a,onActiveArchiveStart:h},item.key))]})';
  source = replaceOnce(source, 'children:[te,re,ie]', `children:[codexPartition.pinned.length>0?${group}:null,te,re,ie]`);
  // 分组数组每次重新派生，包含最新会话元数据；全已置顶时也重绘活动行及回调。
  source = replaceOnce(source, 't[24]!==B.Section||t[25]!==te||t[26]!==re||t[27]!==ie?',
    't[34]!==codexPartition.pinned||t[24]!==B.Section||t[25]!==te||t[26]!==re||t[27]!==ie?');
  source = replaceOnce(source, 't[27]=ie,t[28]=V', 't[27]=ie,t[34]=codexPartition.pinned,t[28]=V');
  const localEmpty = 'F.length?F.map(e=>(0,Z.jsx)(Tn,{conversationId:e.id,hostId:e.hostId,updatedAt:e.recencyAt??e.updatedAt,isActive:x===e.id,onClose:a,onActiveArchiveStart:h},e.id)):M?';
  source = replaceOnce(source, localEmpty, localEmpty.replace(':M?', ':codexPartition.pinned.length>0?null:M?'));
  return replaceOnce(source, 'I.length===0?M?', 'I.length===0?codexPartition.pinned.length>0?null:M?');
}

function transformNativeHeader(source, profile) {
  if (profile.splitHistory) return transformSplitNativeHeader(source, profile);
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
  if (profile.baseOnly) return [];
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
  if (profile.baseOnly) return [];
  return [{ file: `webview/assets/${profile.headerWrapper}`, originalHash: profile.wrapperHash },
    ...(profile.dependencies ?? []).map(([file, originalHash]) => ({ file: `webview/assets/${file}`, originalHash }))];
}

module.exports = { getNativePatchFiles, getNativeDependencies, isHelperDocument, nativePinnedThreads, navigateHistoryInPlace, partitionNativeHistory };
