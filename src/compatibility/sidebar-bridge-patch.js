'use strict';

const { nativePinnedThreads } = require('./native-history-patch');

const PROFILES = {
  '26.5908.31748': { exportedLocation: 'xW', location: 'Qo', api: 'qf',
    hostAnchor: 'e.push(dt),e.push({dispose:xB', host: 'dt', vscode: 'bt' },
  '26.908.40401': { exportedLocation: 'xW', location: 'Zo', api: 'Jf',
    hostAnchor: 'e.push(dt),e.push({dispose:xB', host: 'dt', vscode: 'bt' },
  '26.917.61114': { exportedLocation: 'RZ', location: 'Hr', api: 'hp',
    hostAnchor: 'e.push(Ue),e.push({dispose:LU', host: 'Ue', vscode: 'xt' },
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
  const accountLogins = new Map();
  let accountLoginStarting = false;
  let accountActivityRevision = 0;
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
      if (!disposed && ((message?.method === 'thread/status/changed' && params?.status?.type === 'active')
        || message?.method === 'turn/started')) accountActivityRevision++;
      if (!disposed && message?.method === 'account/login/completed') {
        if (validId(params?.loginId) && typeof params.success === 'boolean'
          && (accountLogins.has(params.loginId) || accountLoginStarting)) {
          rememberLogin(params.loginId, params.success ? 'success' : 'failed');
        }
        return;
      }
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
      accountActivityRevision++;
      for (const [id, login] of accountLogins) if (login.status === 'pending') rememberLogin(id, 'failed');
      for (const ticket of stopTickets.values()) clearTimeout(ticket.timer);
      stopTickets.clear();
      for (const [id, value] of runtimes) runtimes.set(id, { revision: value.revision + 1, known: false });
      for (const id of [...pending.keys()]) finish(id, failure('RPC_FAILED'));
    },
  });

  // 对系统边界的参数做最小限制；不暴露 token 读取、模型执行或任意方法转发。
  function rpc(method, input, internal = false, requestTimeoutMs = timeoutMs) {
    const allowed = new Set(['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume',
      'thread/list', 'thread/search', 'thread/read', 'thread/name/set']);
    if (internal) {
      for (const method of ['thread/turns/list', 'turn/interrupt', 'thread/loaded/list', 'account/login/start', 'account/login/cancel', 'config/read']) allowed.add(method);
    }
    if (!allowed.has(method)) throw failure('UNSUPPORTED_METHOD');
    if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw failure('INVALID_REQUEST');
    const params = { ...input };
    if (method === 'config/read'
      && (params.includeLayers !== false || Object.keys(params).length !== 1)) throw failure('INVALID_REQUEST');
    if (method === 'account/login/start'
      && (params.type !== 'chatgpt' || Object.keys(params).length !== 1)) throw failure('INVALID_REQUEST');
    if (method === 'account/login/cancel'
      && (!validId(params.loginId) || Object.keys(params).length !== 1)) throw failure('INVALID_REQUEST');
    if (method === 'thread/loaded/list'
      && (Object.keys(params).some(key => !['limit', 'cursor'].includes(key)) || params.limit !== 100
        || (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 8192)))) throw failure('INVALID_REQUEST');
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
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { host.codexMcpConnection.sendRequest(providerName, id, method, params); }
      catch { finish(id, failure('RPC_FAILED')); }
    });
  }

  function rememberLogin(id, status) {
    accountLogins.set(id, { status, expiresAt: Date.now() + 15 * 60 * 1000 });
    for (const [key, value] of accountLogins) if (value.expiresAt <= Date.now()) accountLogins.delete(key);
    while (accountLogins.size > 20) accountLogins.delete(accountLogins.keys().next().value);
  }

  async function accountEnvironment() {
    const messages = {
      remote: '多账号暂不支持远程 Codex 环境，请在本机窗口使用。',
      wsl: '多账号暂不支持 WSL 环境，请在本机 Codex 环境使用。',
      'local-host-unavailable': '无法确认本机 Codex 运行环境，请重载窗口后重试。',
      'home-unavailable': '无法确认本机 Codex 登录缓存目录，请重载窗口后重试。',
      'auth-storage-unsupported': '当前登录缓存方式不支持多账号；需要文件式 ChatGPT 登录缓存。',
      'login-method-restricted': '当前配置限制为非 ChatGPT 登录方式，无法使用多账号。',
      'workspace-restriction-invalid': '无法确认当前 ChatGPT 工作区限制，暂不能使用多账号。',
      'config-unavailable': '无法读取 Codex 有效配置，请稍后刷新重试。',
      'environment-timeout': '检查 Codex 多账号环境超时，请稍后刷新重试。',
    };
    const unavailable = (reason, message = messages[reason]) => ({ supported: false, reason, message });
    const client = host.appServerClient;
    if (vscode.env?.remoteName === 'wsl' || client?.runsInsideWsl === true) return unavailable('wsl');
    if (vscode.env?.remoteName) return unavailable('remote');
    // 已审计官方 ExecutionHost：isLocal 是布尔属性，WSL 另有 runsInsideWsl 标记。
    if (client?.isLocal !== true || client.hostConfig?.kind !== 'local'
      || client.hostConfig.id !== 'local' || client.runsInsideWsl !== false
      || typeof client.codexHome !== 'function' || typeof client.platformPath !== 'function') return unavailable('local-host-unavailable');
    let timer;
    let phase = 'home-unavailable';
    try {
      const [home, platformPath] = await Promise.race([
        Promise.all([client.codexHome(), client.platformPath()]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('RPC_TIMEOUT')), timeoutMs); }),
      ]);
      if (disposed || typeof home !== 'string' || home.length > 4096 || /[\x00-\x1f]/.test(home)
        || !['/', '\\'].includes(platformPath?.sep) || typeof platformPath.isAbsolute !== 'function'
        || !platformPath.isAbsolute(home) || typeof platformPath.normalize !== 'function'
        || platformPath.normalize(home) !== home || home.startsWith('\\\\') || home.startsWith('//')
        || home === platformPath.parse(home).root) return unavailable('home-unavailable');
      // Read effective settings (including managed/CLI overrides); never return arbitrary configuration.
      phase = 'config-unavailable';
      const effective = await rpc('config/read', { includeLayers: false }, true);
      const config = effective?.config;
      if (disposed || !config) return unavailable('config-unavailable');
      if (config.cli_auth_credentials_store !== 'file') {
        const storageMessages = {
          keyring: '当前使用系统钥匙串保存登录，多账号暂不支持钥匙串缓存。',
          auto: '当前登录缓存使用自动选择模式，无法保证账号保存在文件中，暂不能使用多账号。',
          ephemeral: '当前登录仅保存在内存中，无法保存和切换多账号。',
        };
        const storage = config.cli_auth_credentials_store;
        return unavailable('auth-storage-unsupported', typeof storage === 'string' && Object.hasOwn(storageMessages, storage)
          ? storageMessages[storage] : messages['auth-storage-unsupported']);
      }
      if (config.forced_login_method != null && config.forced_login_method !== 'chatgpt') return unavailable('login-method-restricted');
      const forced = config.forced_chatgpt_workspace_id;
      const forcedWorkspaceIds = forced == null ? [] : typeof forced === 'string' ? [forced] : forced;
      if (!Array.isArray(forcedWorkspaceIds) || forcedWorkspaceIds.length > 100
        || !forcedWorkspaceIds.every(id => validId(id))) return unavailable('workspace-restriction-invalid');
      return { supported: true, home, authStorage: 'file', forcedWorkspaceIds: [...new Set(forcedWorkspaceIds)] };
    } catch (error) { return unavailable(error?.code === 'CODEX_MULTI_TAB_RPC_TIMEOUT' ? 'environment-timeout' : phase); }
    finally { clearTimeout(timer); }
  }

  async function accountSwitchPreflight() {
    const unknown = { safe: false, message: '无法确认所有 Codex 会话均已停止，请稍后重试。' };
    const deadline = Date.now() + timeoutMs;
    const activityRevision = accountActivityRevision;
    const call = (method, params) => {
      const remaining = deadline - Date.now();
      if (disposed || remaining <= 0) throw failure('RPC_TIMEOUT');
      return rpc(method, params, true, remaining);
    };
    try {
      const cursors = new Set(), ids = new Set();
      let cursor;
      for (let page = 0; page < 100; page++) {
        const result = await call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || !result.data.every(validId)) return unknown;
        for (const id of result.data) ids.add(id);
        if (ids.size > 10000) return unknown;
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192
          || cursors.has(result.nextCursor) || page === 99) return unknown;
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      // 扫描连接中全部已加载会话，不限制项目、可见面板或侧栏历史页。
      const allIds = [...ids];
      for (let index = 0; index < allIds.length; index += 10) {
        const batch = allIds.slice(index, index + 10);
        const results = await Promise.all(batch.map(threadId => call('thread/read', { threadId, includeTurns: false })));
        for (let item = 0; item < results.length; item++) {
          const thread = results[item]?.thread;
          if (thread?.id !== batch[item]) return unknown;
          if (thread.status?.type === 'active') return { safe: false, message: '仍有 Codex 会话正在运行，请先停止后再切换账号。' };
          if (!['idle', 'notLoaded'].includes(thread.status?.type)) return unknown;
        }
      }
      return disposed || accountActivityRevision !== activityRevision ? unknown : { safe: true };
    } catch { return unknown; }
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
        case 'status': return { version: 1, capabilities: { runtime: true, stop: true, accounts: true } };
        case 'accountEnvironment': return accountEnvironment();
        case 'accountSwitchPreflight': return accountSwitchPreflight();
        case 'accountLogin': {
          if (accountLoginStarting || !((await accountEnvironment()).supported)) throw failure('UNSUPPORTED_METHOD');
          if (accountLoginStarting) throw failure('INVALID_REQUEST');
          accountLoginStarting = true;
          try {
            const result = await rpc('account/login/start', { type: 'chatgpt' }, true);
            if (result?.type !== 'chatgpt' || !validId(result.loginId)) throw failure('RPC_FAILED');
            let url;
            try { url = new URL(result.authUrl); } catch { throw failure('RPC_FAILED'); }
            if (typeof result.authUrl !== 'string' || result.authUrl.length > 16384 || url.protocol !== 'https:'
              || url.hostname !== 'auth.openai.com' || url.username || url.password || (url.port && url.port !== '443')) throw failure('RPC_FAILED');
            if (!accountLogins.has(result.loginId)) rememberLogin(result.loginId, 'pending');
            return { loginId: result.loginId, authUrl: result.authUrl };
          } finally { accountLoginStarting = false; }
        }
        case 'cancelAccountLogin': {
          if (!validId(request.loginId)) throw failure('INVALID_REQUEST');
          if (!accountLogins.has(request.loginId)) throw failure('INVALID_REQUEST');
          const result = await rpc('account/login/cancel', { loginId: request.loginId }, true);
          if (!['canceled', 'notFound'].includes(result?.status)) throw failure('RPC_FAILED');
          rememberLogin(request.loginId, 'failed');
          return { status: result.status };
        }
        case 'accountLoginStatus': {
          if (!validId(request.loginId)) throw failure('INVALID_REQUEST');
          const login = accountLogins.get(request.loginId);
          if (!login || login.expiresAt <= Date.now()) {
            accountLogins.delete(request.loginId);
            return { status: 'unknown' };
          }
          return { status: login.status, ...(login.status === 'success' ? { success: true }
            : login.status === 'failed' ? { success: false, message: '账号登录未完成，请重新登录。' } : {}) };
        }
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
      accountLogins.clear();
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

function transformSidebarHost(source, version = '26.908.40401') {
  const profile = PROFILES[version];
  if (!profile) throw new Error('此版本尚未审计侧栏路由桥');
  source = replaceOnce(source, profile.hostAnchor,
    `e.push(${profile.host}),(${registerSidebarBridge.toString()})(${profile.host},${profile.vscode},t,(${nativePinnedThreads.toString()})),e.push({dispose:${version === '26.917.61114' ? 'LU' : 'xB'}`);
  return replaceOnce(source, 'case"ready":break;case"persisted-atom-sync-request":',
    'case"codex-multi-tab-route":{this.codexMultiTabSidebarBridge?.trackRoute(e,r.pathname);break;}case"ready":break;case"persisted-atom-sync-request":');
}

function transformSidebarWebview(source, version) {
  const profile = PROFILES[version];
  if (!profile) throw new Error('此版本尚未审计侧栏路由桥');
  source = replaceOnce(source, `${profile.exportedLocation} as ${profile.location},`,
    `${profile.exportedLocation} as codexMultiTabOriginalLocation,`);
  return source + `\nfunction ${profile.location}(){const location=codexMultiTabOriginalLocation();q().useLayoutEffect(()=>{(${reportSidebarRoute.toString()})(${profile.api},location.pathname)},[location.pathname]);return location}\n`;
}

module.exports = { registerSidebarBridge, reportSidebarRoute, transformSidebarHost, transformSidebarWebview };
