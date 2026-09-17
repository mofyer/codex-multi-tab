'use strict';

const { nativePinnedThreads } = require('./native-history-patch');

const PROFILES = {
  '26.5908.31748': { location: 'Qo', api: 'qf' },
  '26.908.40401': { location: 'Zo', api: 'Jf' },
};

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('侧栏桥特征不唯一或缺失，拒绝修改');
  return source.replace(anchor, () => replacement);
}

/** 只在 React 提交真实路由后上报；复用已有 API，不从标题或初始 URI 猜会话。 */
function reportSidebarRoute(api, pathname, doc = document) {
  if (!api || typeof pathname !== 'string' || pathname.length > 2048) return;
  if (doc.codexMultiTabLastReportedRoute === pathname) return;
  doc.codexMultiTabLastReportedRoute = pathname;
  api.postMessage({ type: 'codex-multi-tab-route', pathname });
}

/** 固定命令和 RPC 白名单，复用官方已认证连接、置顶状态与真实面板。 */
function registerSidebarBridge(host, vscode, context, updatePins, timeoutMs = 15000) {
  const providerName = 'codexMultiTab.sidebar';
  const pending = new Map();
  const routes = new Map();
  const seenPanels = new Set();
  const panelDisposables = new Map();
  const runtimes = new Map();
  const runtimeReads = new Map();
  const stopping = new Set();
  const stopTickets = new Map();
  let disposed = false;
  let sequence = 0;
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
  const failure = code => Object.assign(new Error({
    INVALID_REQUEST: '侧栏请求参数无效。',
    UNSUPPORTED_METHOD: '侧栏不支持此操作。',
    RPC_FAILED: '官方 Codex 请求失败，请刷新后重试。',
    RPC_TIMEOUT: '官方 Codex 请求超时，请刷新后重试。',
    DISPOSED: 'Codex 侧栏连接已关闭，请重载窗口。',
  }[code]), { code: `CODEX_MULTI_TAB_${code}` });
  const finish = (id, error, result) => {
    const request = pending.get(String(id));
    if (!request) return;
    pending.delete(String(id));
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  };
  const provider = host.codexMcpConnection.registerProvider(providerName, {
    onNotification(message) {
      const params = message?.params;
      if (disposed || !validId(params?.threadId) || !runtimes.has(params.threadId)) return;
      const previous = runtimes.get(params.threadId);
      if (message.method === 'thread/status/changed') {
        const type = params.status?.type;
        if (!['active', 'idle', 'notLoaded', 'systemError'].includes(type)) return;
        runtimes.set(params.threadId, { revision: previous.revision + 1, known: true,
          isRunning: type === 'active', runningTurnId: type === 'active' ? previous.runningTurnId : undefined });
      } else if (message.method === 'turn/started' && validId(params.turn?.id) && params.turn.status === 'inProgress') {
        runtimes.set(params.threadId, { revision: previous.revision + 1, known: true,
          isRunning: true, runningTurnId: params.turn.id });
      } else if (message.method === 'turn/completed' && validId(params.turn?.id)
        && (!previous.runningTurnId || previous.runningTurnId === params.turn.id)) {
        runtimes.set(params.threadId, { revision: previous.revision + 1, known: true, isRunning: false });
      }
    },
    onResult(message) {
      finish(message.id, message.error || message.result == null ? failure('RPC_FAILED') : null, message.result);
    },
    onFatalError() {
      for (const ticket of stopTickets.values()) clearTimeout(ticket.timer);
      stopTickets.clear();
      for (const [id, value] of runtimes) runtimes.set(id, { revision: value.revision + 1, known: false });
      for (const id of [...pending.keys()]) finish(id, failure('RPC_FAILED'));
    },
  });

  // 对系统边界的参数做最小限制；不暴露 token 读取、模型执行或任意方法转发。
  function rpc(method, input, internal = false) {
    const allowed = new Set(['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume',
      'thread/list', 'thread/search', 'thread/read', 'thread/name/set']);
    if (internal) { allowed.add('thread/turns/list'); allowed.add('turn/interrupt'); }
    if (!allowed.has(method)) throw failure('UNSUPPORTED_METHOD');
    if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw failure('INVALID_REQUEST');
    const params = { ...input };
    if (method === 'turn/interrupt') {
      if (!validId(params.threadId) || !validId(params.turnId)
        || Object.keys(params).some(key => !['threadId', 'turnId'].includes(key))) throw failure('INVALID_REQUEST');
    }
    if (method === 'thread/turns/list') {
      if (!validId(params.threadId)) throw failure('INVALID_REQUEST');
      params.limit = 1; params.sortDirection = 'desc'; params.itemsView = 'notLoaded';
    }
    if (method === 'account/read') {
      if (Object.keys(params).some(key => key !== 'refreshToken')) throw failure('INVALID_REQUEST');
      params.refreshToken = false;
    }
    if (method === 'account/rateLimits/read') {
      if (Object.keys(params).some(key => !['excludeResetCreditDetails', 'supportsLunaReserve'].includes(key))
        || Object.values(params).some(value => typeof value !== 'boolean')) throw failure('INVALID_REQUEST');
    }
    if (method === 'thread/read' || method === 'thread/name/set') {
      if (!validId(params.threadId)) throw failure('INVALID_REQUEST');
      if (method === 'thread/read') {
        if (Object.keys(params).some(key => !['threadId', 'includeTurns'].includes(key))) throw failure('INVALID_REQUEST');
        params.includeTurns = false;
      } else if (Object.keys(params).some(key => !['threadId', 'name'].includes(key))
        || typeof params.name !== 'string' || !params.name.trim() || params.name.length > 500) throw failure('INVALID_REQUEST');
    }
    if (method === 'account/rateLimitResetCredit/consume') {
      if (Object.keys(params).some(key => !['creditId', 'idempotencyKey'].includes(key))
        || typeof params.creditId !== 'string' || !params.creditId || params.creditId.length > 512
        || typeof params.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(params.idempotencyKey)) {
        throw failure('INVALID_REQUEST');
      }
    }
    if (method === 'thread/list' || method === 'thread/search') {
      const keys = ['limit', 'cursor', 'sortKey', 'sortDirection', 'archived', 'sourceKinds', 'searchTerm'];
      if (method === 'thread/list') keys.push('modelProviders', 'useStateDbOnly', 'cwd');
      if (Object.keys(params).some(key => !keys.includes(key))
        || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200))
        || (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 8192))
        || (params.searchTerm != null && (typeof params.searchTerm !== 'string' || params.searchTerm.length > 2000))
        || (method === 'thread/search' && !params.searchTerm?.trim())) throw failure('INVALID_REQUEST');
      if (method === 'thread/list') params.useStateDbOnly = true;
    }
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.codexMcpConnection.abandonRequest(providerName, id);
        finish(id, failure('RPC_TIMEOUT'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { host.codexMcpConnection.sendRequest(providerName, id, method, params); }
      catch { finish(id, failure('RPC_FAILED')); }
    });
  }

  /** 初次补读元数据，此后复用官方通知；不拉取消息正文，也不每两秒扫描全部历史。 */
  async function readRuntime(threadId, force = false) {
    if (runtimeReads.has(threadId)) return runtimeReads.get(threadId);
    if (!force && runtimes.get(threadId)?.known
      && (!runtimes.get(threadId).isRunning || runtimes.get(threadId).runningTurnId)) return runtimes.get(threadId);
    if (!runtimes.has(threadId)) runtimes.set(threadId, { revision: 0, known: false });
    const revision = runtimes.get(threadId).revision;
    const request = (async () => {
      try {
        const result = await rpc('thread/read', { threadId, includeTurns: false });
        if (disposed) throw failure('DISPOSED');
        if (result?.thread?.id !== threadId) throw failure('RPC_FAILED');
        const type = result.thread.status?.type;
        if (!['active', 'idle', 'notLoaded', 'systemError'].includes(type)) throw failure('RPC_FAILED');
        let runningTurnId;
        if (type === 'active') {
          const turns = await rpc('thread/turns/list', { threadId }, true);
          if (disposed) throw failure('DISPOSED');
          if (!Array.isArray(turns?.data)) throw failure('RPC_FAILED');
          const turn = turns.data[0];
          if (turn?.status === 'inProgress' && validId(turn.id)) runningTurnId = turn.id;
        }
        if (runtimes.get(threadId)?.revision === revision) runtimes.set(threadId,
          { revision, known: true, isRunning: type === 'active', runningTurnId });
      } catch {
        if (!disposed && runtimes.get(threadId)?.revision === revision) runtimes.set(threadId, { revision, known: false });
      }
      return runtimes.get(threadId);
    })();
    runtimeReads.set(threadId, request);
    try { return await request; } finally { if (runtimeReads.get(threadId) === request) runtimeReads.delete(threadId); }
  }

  function watchPanel(panel) {
    if (panelDisposables.has(panel)) return;
    panelDisposables.set(panel, panel.onDidDispose(() => {
      routes.delete(panel);
      seenPanels.delete(panel);
      panelDisposables.get(panel)?.dispose();
      panelDisposables.delete(panel);
    }));
  }

  // openWith 已返回但 webview 尚未提交路由时，创建时的目标是唯一可信初值。
  // 只读取一次；实际路由上报（含空白页）后绝不重新回退到 initialRoute。
  function livePanels() {
    for (const [panel, state] of host.editorPanels) {
      if (!host.isPanelAlive(panel) || seenPanels.has(panel)) continue;
      seenPanels.add(panel);
      watchPanel(panel);
      const initialRoute = state.initialRoute;
      const match = typeof initialRoute === 'string' && /^\/local\/([A-Za-z0-9_-]{1,200})\?([^#]*)$/.exec(initialRoute);
      if (match && new URLSearchParams(match[2]).get('codexMultiTab')) routes.set(panel, match[1]);
    }
    return [...routes].filter(([panel]) => host.editorPanels.has(panel) && host.isPanelAlive(panel));
  }

  const bridge = {
    trackRoute(webview, pathname) {
      if (disposed || typeof pathname !== 'string' || pathname.length > 2048 || !pathname.startsWith('/')) return;
      const panel = host.findPanelByWebview(webview);
      if (!panel || !host.editorPanels.has(panel) || !host.isPanelAlive(panel)) return;
      seenPanels.add(panel);
      watchPanel(panel);
      const match = /^\/local\/([A-Za-z0-9_-]{1,200})\/?$/.exec(pathname);
      routes.set(panel, match?.[1] ?? null);
    },
    async handle(request) {
      if (disposed) throw failure('DISPOSED');
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('INVALID_REQUEST');
      switch (request.action) {
        case 'status': return { version: 1, capabilities: { runtime: true, stop: true } };
        case 'runtime': {
          if (!Array.isArray(request.threadIds) || request.threadIds.length > 200 || !request.threadIds.every(validId)) throw failure('INVALID_REQUEST');
          const ids = [...new Set(request.threadIds)];
          for (let index = 0; index < ids.length; index += 10) {
            if (disposed) throw failure('DISPOSED');
            await Promise.all(ids.slice(index, index + 10).map(id => readRuntime(id)));
          }
          if (disposed) throw failure('DISPOSED');
          return { supported: true, threads: ids.map(threadId => {
            const state = runtimes.get(threadId);
            return { threadId, isRunning: state?.known ? state.isRunning : undefined,
              runningTurnId: state?.known && state.isRunning ? state.runningTurnId : undefined };
          }) };
        }
        case 'prepareStop': {
          const { threadId, turnId } = request;
          if (!validId(threadId) || !validId(turnId)) throw failure('INVALID_REQUEST');
          if (stopping.has(threadId)) return { token: null };
          const previous = runtimes.get(threadId);
          if (!previous?.known || !previous.isRunning || previous.runningTurnId !== turnId) return { token: null };
          stopping.add(threadId);
          try {
            await readRuntime(threadId, true);
            const latest = runtimes.get(threadId);
            if (disposed) throw failure('DISPOSED');
            if (!latest?.known || !latest.isRunning || latest.runningTurnId !== turnId) return { token: null };
            const token = String(++sequence);
            const old = stopTickets.get(threadId);
            if (old) clearTimeout(old.timer);
            const ticket = { token, turnId, expiresAt: Date.now() + 30000 };
            ticket.timer = setTimeout(() => { if (stopTickets.get(threadId) === ticket) stopTickets.delete(threadId); }, 30000);
            ticket.timer?.unref?.();
            stopTickets.set(threadId, ticket);
            return { token };
          } finally { stopping.delete(threadId); }
        }
        case 'stop': {
          const { threadId, turnId, token } = request;
          if (!validId(threadId) || !validId(turnId) || !validId(token)) throw failure('INVALID_REQUEST');
          const ticket = stopTickets.get(threadId);
          if (!ticket || ticket.token !== token || ticket.turnId !== turnId) return { interrupted: false };
          clearTimeout(ticket.timer);
          stopTickets.delete(threadId);
          const latest = runtimes.get(threadId);
          if (ticket.expiresAt <= Date.now() || stopping.has(threadId)
            || !latest?.known || !latest.isRunning || latest.runningTurnId !== turnId) return { interrupted: false };
          stopping.add(threadId);
          try {
            // 准备完成后由辅助扩展复核当前项目；本阶段不再 await，立即发送精确轮次。
            const response = rpc('turn/interrupt', { threadId, turnId }, true);
            await response;
            return { interrupted: true };
          } finally { stopping.delete(threadId); }
        }
        case 'rpc': return rpc(request.method, request.params);
        case 'pins':
          try { return await updatePins(host.globalState, request.input); }
          catch { throw failure('RPC_FAILED'); }
        case 'panels': return { threadIds: [...new Set(livePanels().flatMap(([, id]) => id ? [id] : []))] };
        case 'reveal': {
          if (!validId(request.threadId)) throw failure('INVALID_REQUEST');
          const panel = livePanels().find(([, id]) => id === request.threadId)?.[0];
          if (!panel) return { revealed: false };
          panel.reveal(panel.viewColumn, false);
          return { revealed: true };
        }
        default: throw failure('UNSUPPORTED_METHOD');
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      command.dispose();
      for (const id of [...pending.keys()]) {
        host.codexMcpConnection.abandonRequest(providerName, id);
        finish(id, failure('DISPOSED'));
      }
      provider.dispose();
      for (const disposable of panelDisposables.values()) disposable.dispose();
      panelDisposables.clear();
      routes.clear();
      seenPanels.clear();
      runtimes.clear();
      runtimeReads.clear();
      stopping.clear();
      for (const ticket of stopTickets.values()) clearTimeout(ticket.timer);
      stopTickets.clear();
      if (host.codexMultiTabSidebarBridge === bridge) delete host.codexMultiTabSidebarBridge;
    },
  };
  let command;
  try { command = vscode.commands.registerCommand('codexMultiTab.internalBridge', request => bridge.handle(request)); }
  catch (error) { provider.dispose(); throw error; }
  host.codexMultiTabSidebarBridge = bridge;
  context.subscriptions.push(bridge);
  return bridge;
}

function transformSidebarHost(source) {
  source = replaceOnce(source, 'e.push(dt),e.push({dispose:xB',
    `e.push(dt),(${registerSidebarBridge.toString()})(dt,bt,t,(${nativePinnedThreads.toString()})),e.push({dispose:xB`);
  return replaceOnce(source, 'case"ready":break;case"persisted-atom-sync-request":',
    'case"codex-multi-tab-route":{this.codexMultiTabSidebarBridge?.trackRoute(e,r.pathname);break;}case"ready":break;case"persisted-atom-sync-request":');
}

function transformSidebarWebview(source, version) {
  const profile = PROFILES[version];
  if (!profile) throw new Error('此版本尚未审计侧栏路由桥');
  source = replaceOnce(source, `xW as ${profile.location},`, 'xW as codexMultiTabOriginalLocation,');
  return source + `\nfunction ${profile.location}(){const location=codexMultiTabOriginalLocation();q().useLayoutEffect(()=>{(${reportSidebarRoute.toString()})(${profile.api},location.pathname)},[location.pathname]);return location}\n`;
}

module.exports = { registerSidebarBridge, reportSidebarRoute, transformSidebarHost, transformSidebarWebview };
