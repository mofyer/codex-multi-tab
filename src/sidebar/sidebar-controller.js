'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const BRIDGE = 'codexMultiTab.internalBridge';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const seconds = value => Number.isFinite(value) && value > 0 ? value : undefined;
const text = (value, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : '';

/** 目录归属按路径段比较；Windows 路径统一分隔符与大小写，不把相邻名称当成子目录。 */
function normalizeWorkspacePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value);
  const parser = windows ? path.win32 : path.posix;
  if (!parser.isAbsolute(value)) return null;
  return { windows, value: windows ? parser.normalize(value).toLowerCase() : parser.normalize(value) };
}

function isWorkspacePath(cwd, roots) {
  const candidate = normalizeWorkspacePath(cwd);
  if (!candidate) return false;
  const parser = candidate.windows ? path.win32 : path.posix;
  return roots.some(root => {
    const normalized = normalizeWorkspacePath(root);
    if (!normalized || candidate.windows !== normalized.windows) return false;
    const relative = parser.relative(normalized.value, candidate.value);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${parser.sep}`) && !parser.isAbsolute(relative));
  });
}

/** 仅归一化协议中的真实窗口；无数据不等同于零使用。 */
function normalizeLimits(result, now = Date.now() / 1000) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : [['codex', result?.rateLimits]];
  const windows = [];
  for (const [id, bucket] of buckets) {
    for (const key of ['primary', 'secondary']) {
      const window = bucket?.[key];
      if (!Number.isFinite(window?.usedPercent) || window.usedPercent < 0) continue;
      const minutes = window.windowDurationMins;
      const duration = minutes === 10080 ? '每周' : minutes === 300 ? '5 小时'
        : Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : key === 'primary' ? '主额度' : '次额度';
      windows.push({ id: `${id}:${key}`, label: `${text(bucket.limitName || id, 60)} · ${duration}`,
        usedPercent: window.usedPercent, resetsAt: seconds(window.resetsAt) });
    }
  }
  const summary = result?.rateLimitResetCredits;
  const known = Array.isArray(summary?.credits);
  const credits = { status: known ? 'ready' : 'unavailable', items: [],
    message: known ? undefined : '官方暂未提供重置卡详情。' };
  if (Number.isSafeInteger(summary?.availableCount) && summary.availableCount >= 0) {
    credits.availableCount = summary.availableCount;
  }
  if (known) {
    credits.items = summary.credits.filter(card => typeof card?.id === 'string' && card.id.length > 0 && card.id.length <= 500).map(card => ({
      id: card.id, title: text(card.title) || '额度重置卡', expiresAt: seconds(card.expiresAt),
      available: card.status === 'available' && card.resetType === 'codexRateLimits'
        && (card.expiresAt == null || (seconds(card.expiresAt) !== undefined && card.expiresAt > now)),
    }));
  }
  return { usage: { status: windows.length ? 'ready' : 'unavailable', windows,
    message: windows.length ? undefined : '官方暂未提供用量窗口。' }, credits };
}

/** 不读取会话正文；搜索响应与普通列表使用不同的协议外层。 */
function normalizeThread(raw, pinned, opened) {
  if (!validId(raw?.id)) throw new Error('会话格式无效');
  return { id: raw.id, title: text(raw.name?.trim()) || text(raw.preview, 120) || '未命名会话',
    preview: text(raw.preview, 160), cwd: text(raw.cwd, 500), updatedAt: seconds(raw.updatedAt || raw.createdAt),
    isPinned: pinned.has(raw.id), isOpen: opened.has(raw.id) };
}

/** 管理侧栏异步状态；数据通过当前官方连接取得，不读取认证文件。 */
function createSidebarController(vscode, context, { postState, openNewTab, openThreadTab, timers = globalThis }) {
  let disposed = false;
  let generation = 0;
  let listGeneration = 0;
  let cursor = null;
  let ready = false;
  let resetBusy = false;
  let listBusy = false;
  let scopeGeneration = 0;
  let visitedCursors = new Set();
  let threadDirectories = new Map();
  let accountGeneration = 0;
  let accountFlight = null;
  let accountTimer;
  let runtimeTimer;
  let runtimeFlight = null;
  let runtimeSupported = false;
  let stopSupported = false;
  const stops = new Map();
  const mutations = new Set();
  const openings = new Map();
  const resetKeys = new Map();
  const state = {
    loading: false, account: { status: 'unavailable', message: '等待连接官方 Codex。' },
    usage: { status: 'unavailable', windows: [] }, credits: { status: 'unavailable', items: [] },
    threads: { items: [], loading: false, hasMore: false, query: '' },
    capabilities: { pin: false, open: false, reset: false, stop: false },
  };
  const emit = () => { if (!disposed) postState(JSON.parse(JSON.stringify(state))); };
  const bridge = request => vscode.commands.executeCommand(BRIDGE, request);
  const rpc = (method, params) => bridge({ action: 'rpc', method, params });
  const info = message => { if (!disposed) return vscode.window.showInformationMessage(message); };

  function workspaceScope() {
    const folders = vscode.workspace?.workspaceFolders || [];
    const unsupported = folders.some(folder => folder.uri?.scheme !== 'file');
    const roots = unsupported ? [] : [...new Set(folders.map(folder => normalizeWorkspacePath(folder.uri.fsPath)?.value).filter(Boolean))].sort();
    return { roots, key: JSON.stringify([unsupported, roots]), message: unsupported
      ? '当前远程或虚拟工作区暂不支持项目会话隔离，请打开本地项目。'
      : '请先打开项目文件夹，再查看当前项目的 Codex 会话。' };
  }

  const sameScope = (version, scope) => !disposed && version === scopeGeneration && scope.key === workspaceScope().key;
  const canOperate = (id, version, scope) => sameScope(version, scope)
    && state.threads.items.some(item => item.id === id) && isWorkspacePath(threadDirectories.get(id), scope.roots);

  async function verifyThreadScope(id, version, scope) {
    if (!canOperate(id, version, scope)) return false;
    const result = await rpc('thread/read', { threadId: id, includeTurns: false });
    return canOperate(id, version, scope) && result?.thread?.id === id && isWorkspacePath(result.thread.cwd, scope.roots);
  }

  async function connect() {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official) throw new Error('missing');
    await official.activate();
    if (disposed || !(await vscode.commands.getCommands(true)).includes(BRIDGE)) throw new Error('unavailable');
    const status = await bridge({ action: 'status' });
    if (disposed || status?.version !== 1) throw new Error('version');
    runtimeSupported = status.capabilities?.runtime === true;
    stopSupported = status.capabilities?.stop === true;
    if (!runtimeSupported || !stopSupported) state.capabilities.stop = false;
    if (!runtimeSupported) for (const item of state.threads.items) {
      if (item.isRunning !== undefined || item.runningTurnId !== undefined || item.stopping) Object.assign(item, { isRunning: undefined, runningTurnId: undefined, stopping: false });
    }
    if (runtimeSupported && runtimeTimer === undefined) {
      runtimeTimer = timers.setInterval(() => { void refreshRuntime(); }, 2_000);
      runtimeTimer?.unref?.();
    }
    ready = true;
  }

  async function refreshLimits() {
    const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: false });
    return { ...normalizeLimits(result), accountId: result?.accountId };
  }

  async function refreshAccount(automatic = false) {
    if (disposed || resetBusy || (automatic && accountFlight)) return;
    const token = ++accountGeneration;
    // 手动刷新共用正在进行的账号快照；计时器遇慢请求直接跳过，不排队堆积。
    if (!accountFlight) {
      const pending = (async () => {
        if (automatic || !ready) await connect();
        if (disposed) return;
        const account = await rpc('account/read', { refreshToken: false });
        if (!account || !Object.hasOwn(account, 'account')) throw new Error('shape');
        if (disposed || account.account == null) return { account, limits: null };
        const [limits] = await Promise.allSettled([refreshLimits()]);
        return { account, limits };
      })();
      accountFlight = pending;
      // 注册成功和失败清理，避免未观察的 finally 派生 Promise 造成未处理拒绝。
      const clear = () => { if (accountFlight === pending) accountFlight = null; };
      pending.then(clear, clear);
    }
    try {
      const snapshot = await accountFlight;
      if (disposed || resetBusy || token !== accountGeneration) return;
      const value = snapshot.account.account;
      state.account = value == null ? { status: 'signed-out', message: '请先在官方 Codex 中登录。' }
        : value.type === 'chatgpt' ? { status: 'ready', email: text(value.email), planType: text(value.planType, 80) }
          : { status: 'ready', message: value.type === 'apiKey' ? 'API Key 登录' : '当前账号类型未提供 ChatGPT 订阅信息。' };
      if (snapshot.limits?.status === 'fulfilled') {
        state.usage = snapshot.limits.value.usage;
        state.credits = snapshot.limits.value.credits;
        state.capabilities.reset = snapshot.limits.value.credits.status === 'ready';
      } else {
        state.usage = { status: 'unavailable', windows: [], message: value == null ? '登录后显示官方用量。' : '官方用量接口暂不可用。' };
        state.credits = { status: 'unavailable', items: [], message: value == null ? '登录后显示重置卡。' : '重置卡信息暂不可用。' };
        state.capabilities.reset = false;
      }
      state.error = undefined;
    } catch {
      if (disposed || resetBusy || token !== accountGeneration) return;
      state.account = { status: 'unavailable', message: '账号信息暂时不可用。' };
      state.usage = { status: 'unavailable', windows: [], message: '官方用量接口暂不可用。' };
      state.credits = { status: 'unavailable', items: [], message: '重置卡信息暂不可用。' };
      state.capabilities.reset = false;
    }
    if (!disposed && token === accountGeneration) emit();
  }

  function startAccountTimer() {
    if (accountTimer !== undefined) return;
    accountTimer = timers.setInterval(() => { void refreshAccount(true); }, 60_000);
    accountTimer?.unref?.();
  }

  async function refreshRuntime(waitForPending = false) {
    if (runtimeFlight) {
      if (waitForPending) { await runtimeFlight; return refreshRuntime(); }
      return;
    }
    if (disposed || !ready || !runtimeSupported || listBusy) return;
    const scope = workspaceScope(), scopeToken = scopeGeneration, listToken = listGeneration;
    const ids = state.threads.items.filter(item => canOperate(item.id, scopeToken, scope)).map(item => item.id);
    if (!ids.length) return;
    const current = () => sameScope(scopeToken, scope) && listToken === listGeneration && runtimeSupported && ready;
    const pending = (async () => {
      let rows = new Map(), supported = false;
      try {
        supported = true;
        // 本项目置顶数可能超过普通分页上限，按桥的二百条边界完整读取。
        for (let index = 0; index < ids.length; index += 200) {
          const batch = ids.slice(index, index + 200);
          const response = await bridge({ action: 'runtime', threadIds: batch });
          if (!current()) return;
          if (response?.supported !== true || !Array.isArray(response.threads)) throw new Error('shape');
          for (const item of response.threads) if (batch.includes(item?.threadId)) rows.set(item.threadId, item);
        }
      } catch {
        // 状态未知时撤下停止入口，下轮只重读状态，不重发停止。
        supported = false; rows = new Map();
      }
      if (!current()) return;
      let changed = state.capabilities.stop !== (supported && stopSupported);
      state.capabilities.stop = supported && stopSupported;
      for (const item of state.threads.items) {
        const row = rows.get(item.id);
        const isRunning = typeof row?.isRunning === 'boolean' ? row.isRunning : undefined;
        const runningTurnId = isRunning && validId(row.runningTurnId) ? row.runningTurnId : undefined;
        const stopping = runningTurnId !== undefined && stops.get(item.id) === runningTurnId;
        changed ||= item.isRunning !== isRunning || item.runningTurnId !== runningTurnId || item.stopping !== stopping;
        Object.assign(item, { isRunning, runningTurnId, stopping });
      }
      if (changed) emit();
    })();
    runtimeFlight = pending;
    try { await pending; } finally { if (runtimeFlight === pending) runtimeFlight = null; }
  }

  async function loadThreads(append = false) {
    if (disposed || !ready || (append && (listBusy || !cursor))) return;
    const token = ++listGeneration;
    const scope = workspaceScope();
    const scopeToken = scopeGeneration;
    const current = () => token === listGeneration && sameScope(scopeToken, scope);
    const query = state.threads.query;
    const requestedCursor = append ? cursor : null;
    listBusy = true;
    state.threads.loading = true;
    state.threads.error = undefined;
    if (!append) {
      cursor = null; visitedCursors = new Set(); threadDirectories = new Map();
      state.threads.items = []; state.threads.hasMore = false;
    }
    if (!scope.roots.length) {
      listBusy = false;
      cursor = null; visitedCursors = new Set(); threadDirectories = new Map();
      state.threads = { items: [], loading: false, hasMore: false, query, error: scope.message };
      state.capabilities.pin = false; state.capabilities.open = false;
      emit();
      return;
    }
    emit();
    try {
      const [pinsSnapshot, panelsSnapshot] = await Promise.allSettled([
        bridge({ action: 'pins' }), bridge({ action: 'panels' }),
      ]);
      if (!current()) return;
      const pinsResult = pinsSnapshot.status === 'fulfilled' && Array.isArray(pinsSnapshot.value?.threadIds) ? pinsSnapshot.value : { threadIds: [] };
      const panelsResult = panelsSnapshot.status === 'fulfilled' && Array.isArray(panelsSnapshot.value?.threadIds) ? panelsSnapshot.value : { threadIds: [] };
      const pinned = new Set(pinsResult.threadIds.filter(validId));
      const opened = new Set(panelsResult.threadIds.filter(validId));
      const items = new Map();
      const directories = new Map();
      const scanned = new Set(append ? visitedCursors : []);
      let nextCursor = requestedCursor;
      let repeatedCursor = false;
      const accept = raw => {
        if (!validId(raw?.id) || !isWorkspacePath(raw.cwd, scope.roots)) return;
        directories.set(raw.id, raw.cwd);
        items.set(raw.id, normalizeThread(raw, pinned, opened));
      };
      // 官方 cwd 参数仅精确匹配，搜索还没有该参数；逐页按原始 cwd 过滤才能覆盖子目录。
      for (let pageIndex = 0; pageIndex < 10 && items.size < 50; pageIndex++) {
        if (!current()) return;
        if (scanned.has(nextCursor)) { repeatedCursor = true; nextCursor = null; break; }
        scanned.add(nextCursor);
        const params = { archived: false, limit: 50 - items.size, cursor: nextCursor, sortKey: 'updated_at' };
        const page = await rpc(query ? 'thread/search' : 'thread/list', query ? { ...params, searchTerm: query } : { ...params, modelProviders: [] });
        if (!current()) return;
        if (!Array.isArray(page?.data) || !(page.nextCursor == null || typeof page.nextCursor === 'string') || page.data.length > params.limit) throw new Error('shape');
        for (const row of page.data) accept(query ? row?.thread : row);
        nextCursor = page.nextCursor || null;
        if (nextCursor != null && scanned.has(nextCursor)) { repeatedCursor = true; nextCursor = null; }
        if (!nextCursor) break;
      }
      // 全局置顶只补入当前项目；无法读取的记录归属未知，不能算作本项目失败数量。
      if (!query && !append) {
        const extraIds = [...pinned].filter(id => !items.has(id));
        // 分批读取避免同时发出大量 RPC，所有置顶项均覆盖。
        for (let index = 0; index < extraIds.length; index += 10) {
          if (!current()) return;
          const extras = await Promise.allSettled(extraIds.slice(index, index + 10).map(id => rpc('thread/read', { threadId: id, includeTurns: false })));
          if (!current()) return;
          for (const extra of extras) {
            if (extra.status === 'fulfilled') accept(extra.value?.thread);
          }
        }
      }
      if (!current()) return;
      state.capabilities.pin = pinsResult === pinsSnapshot.value;
      state.capabilities.open = panelsResult === panelsSnapshot.value;
      const unique = new Map((append ? state.threads.items : []).map(item => [item.id, { ...item, isPinned: pinned.has(item.id), isOpen: opened.has(item.id) }]));
      for (const item of items.values()) unique.set(item.id, item);
      for (const [id, cwd] of directories) threadDirectories.set(id, cwd);
      state.threads.items = [...unique.values()].sort((a, b) => Number(b.isPinned) - Number(a.isPinned)
        || (a.isPinned && b.isPinned ? pinsResult.threadIds.indexOf(a.id) - pinsResult.threadIds.indexOf(b.id) : (b.updatedAt || 0) - (a.updatedAt || 0)));
      cursor = nextCursor;
      visitedCursors = scanned;
      state.threads.hasMore = !!cursor;
      if (cursor && items.size < 50) state.threads.error = '尚未扫描完历史记录，请加载更多以继续查找当前项目会话。';
      if (repeatedCursor) state.threads.error = '官方分页游标重复，已停止加载。请刷新后重试。';
      if (!state.capabilities.pin || !state.capabilities.open) state.threads.error = [state.threads.error, '部分原生会话操作暂不可用，可刷新重试。'].filter(Boolean).join(' ');
    } catch {
      if (current()) state.threads.error = '无法读取官方会话，请刷新重试；若刚更新 Codex，请检查兼容提示。';
    } finally {
      if (current()) { listBusy = false; state.threads.loading = false; emit(); await refreshRuntime(); }
    }
  }

  async function refresh() {
    if (disposed) return;
    if (resetBusy) return loadThreads();
    const token = ++generation;
    accountGeneration++;
    state.loading = true;
    state.error = undefined;
    emit();
    try { await connect(); } catch {
      if (disposed || token !== generation) return;
      ready = false;
      state.error = '官方连接尚未就绪。请启用 Codex；若刚应用增强，请在任务结束并保存草稿后重载窗口。未知版本需要兼容适配。';
      state.capabilities = { pin: false, open: false, reset: false, stop: false };
      state.account = { status: 'unavailable' };
      state.usage = { status: 'unavailable', windows: [] };
      state.credits = { status: 'unavailable', items: [] };
      state.loading = false;
      emit();
      return;
    }
    if (disposed || token !== generation) return;
    state.capabilities = { pin: true, open: true, reset: false, stop: false };
    const list = loadThreads();
    await refreshAccount();
    if (disposed || token !== generation) return;
    state.loading = false;
    emit();
    await list;
  }

  async function mutateThread(type, id) {
    if (!ready || !validId(id) || mutations.has(id) || !state.threads.items.some(item => item.id === id)) return;
    const scope = workspaceScope();
    const scopeToken = scopeGeneration;
    if (!canOperate(id, scopeToken, scope)) return;
    mutations.add(id);
    try {
      const current = state.threads.items.find(item => item.id === id);
      if (type === 'renameThread') {
        const name = await vscode.window.showInputBox({ title: '重命名 Codex 会话', value: current.title,
          validateInput: value => !value.trim() ? '请输入会话名称。' : Array.from(value.trim()).length > 200 ? '会话名称请勿超过 200 个字符。' : undefined });
        if (!canOperate(id, scopeToken, scope) || name == null || !name.trim() || Array.from(name.trim()).length > 200) return;
        if (!await verifyThreadScope(id, scopeToken, scope) || !canOperate(id, scopeToken, scope)) return;
        await rpc('thread/name/set', { threadId: id, name: name.trim() });
      } else {
        const fresh = await bridge({ action: 'pins' });
        if (!canOperate(id, scopeToken, scope) || !Array.isArray(fresh?.threadIds)) return;
        if (!await verifyThreadScope(id, scopeToken, scope) || !canOperate(id, scopeToken, scope)) return;
        await bridge({ action: 'pins', input: { threadId: id, pinned: !fresh.threadIds.includes(id) } });
      }
      if (sameScope(scopeToken, scope)) await loadThreads();
    } catch { if (sameScope(scopeToken, scope)) await vscode.window.showErrorMessage('会话操作未完成，请刷新后重试。'); }
    finally { mutations.delete(id); }
  }

  async function openThread(id) {
    if (!ready || !validId(id) || !state.threads.items.some(item => item.id === id)) return;
    const scope = workspaceScope();
    const scopeToken = scopeGeneration;
    if (!canOperate(id, scopeToken, scope)) return;
    if (openings.has(id)) return openings.get(id);
    const operation = (async () => {
      try {
        if (!await verifyThreadScope(id, scopeToken, scope) || !canOperate(id, scopeToken, scope)) return;
        const result = await bridge({ action: 'reveal', threadId: id });
        if (!canOperate(id, scopeToken, scope)) return;
        if (typeof result?.revealed !== 'boolean') throw new Error('shape');
        if (!result.revealed) await openThreadTab(id);
        if (canOperate(id, scopeToken, scope)) {
          const item = state.threads.items.find(item => item.id === id);
          if (item) item.isOpen = true;
          emit();
        }
      } catch { if (sameScope(scopeToken, scope)) await vscode.window.showErrorMessage('无法定位或打开该 Codex 会话，请检查兼容状态。'); }
    })();
    openings.set(id, operation);
    try { await operation; } finally { if (openings.get(id) === operation) openings.delete(id); }
  }

  async function stopThread(id, turnId) {
    if (!ready || !state.capabilities.stop || !validId(id) || !validId(turnId) || stops.has(id)) return;
    const scope = workspaceScope(), scopeToken = scopeGeneration, listToken = listGeneration;
    const current = () => canOperate(id, scopeToken, scope) && listToken === listGeneration;
    const matches = () => current() && state.capabilities.stop && state.threads.items.some(item => item.id === id && item.isRunning && item.runningTurnId === turnId);
    if (!matches()) return;
    stops.set(id, turnId);
    state.threads.items.find(item => item.id === id).stopping = true;
    emit();
    let failed = false;
    try {
      if (!await verifyThreadScope(id, scopeToken, scope) || !matches()) return;
      const prepared = await bridge({ action: 'prepareStop', threadId: id, turnId });
      // 桥的异步复核结束后再确认界面归属；提交票据后桥不再等待其他查询。
      if (!matches() || stops.get(id) !== turnId) return;
      if (typeof prepared?.token !== 'string' || !prepared.token || prepared.token.length > 200) { failed = true; return; }
      const result = await bridge({ action: 'stop', threadId: id, turnId, token: prepared.token });
      if (typeof result?.interrupted !== 'boolean') throw new Error('shape');
      // 返回受理成功也不推断任务已停止，以后续运行态为准。
      failed = !result.interrupted;
    } catch { failed = true; }
    finally {
      if (stops.get(id) === turnId) stops.delete(id);
      if (current()) {
        const item = state.threads.items.find(item => item.id === id);
        item.stopping = false;
        emit();
        await refreshRuntime(true);
        if (failed && current()) await vscode.window.showErrorMessage('未能确认当前轮次已停止，已重新读取运行状态；不会自动重试停止。');
      }
    }
  }

  async function resetCredit(id) {
    if (!ready || resetBusy || typeof id !== 'string' || !state.credits.items.some(card => card.id === id && card.available)) return;
    resetBusy = true;
    accountGeneration++;
    state.credits.busyId = id;
    emit();
    let consumed = false;
    const snapshot = async () => {
      const [limits, account] = await Promise.all([refreshLimits(), rpc('account/read', { refreshToken: false })]);
      const accountId = typeof limits.accountId === 'string' && limits.accountId.trim() ? limits.accountId : undefined;
      const email = account?.account?.type === 'chatgpt' && typeof account.account.email === 'string' && account.account.email.trim()
        ? account.account.email : undefined;
      return { ...limits, identity: accountId ? `id:${accountId}` : email ? `email:${email}` : undefined };
    };
    try {
      // 等待既有自动/手动快照结束，消费核对期间不让账号读取互相重叠。
      if (accountFlight) await accountFlight.catch(() => undefined);
      if (disposed) return;
      const before = await snapshot();
      if (!before.identity) { await info('官方暂未提供可核对的账号身份，本次不消费重置卡。'); return; }
      let card = before.credits.items.find(item => item.id === id && item.available);
      if (!card || disposed) { await info('这张重置卡已不可用或已过期，请刷新后查看。'); return; }
      const expiry = card.expiresAt ? `\n失效时间：${new Date(card.expiresAt * 1000).toLocaleString()}` : '';
      const choice = await vscode.window.showWarningMessage(`将消耗“${card.title}”重置 Codex 官方额度。${expiry}\n此操作会使用真实重置卡。`, { modal: true }, '消耗重置卡并重置');
      if (disposed || choice !== '消耗重置卡并重置') return;
      // 弹窗期间可能切换账号或卡已被其他设备消费，确认后重新核对。
      const latest = await snapshot();
      card = latest.credits.items.find(item => item.id === id && item.available);
      if (disposed) return;
      if (!card || latest.identity !== before.identity) { await info('账号或重置卡状态已变化，请刷新后重试。'); return; }
      if (!resetKeys.has(id)) resetKeys.set(id, randomUUID());
      consumed = true;
      const result = await rpc('account/rateLimitResetCredit/consume', { creditId: id, idempotencyKey: resetKeys.get(id) });
      const messages = { reset: '官方已完成额度重置。', nothingToReset: '官方返回：当前没有需要重置的额度。', noCredit: '官方返回：没有可用重置卡。', alreadyRedeemed: '官方返回：这张卡已经使用。' };
      await info(messages[result?.outcome] || '官方返回了无法识别的重置结果，请刷新确认；不要重复消费。');
    } catch {
      if (!disposed) await vscode.window.showErrorMessage(consumed ? '重置结果暂时无法确认。请刷新官方额度及卡状态；系统不会自动重复消费。' : '无法核对重置卡状态，本次未发起消费。');
    } finally {
      resetBusy = false;
      if (!disposed) { state.credits.busyId = undefined; emit(); await refresh(); }
    }
  }

  async function handleMessage(message) {
    if (disposed || !message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready': startAccountTimer(); return refresh();
      case 'refresh': return refresh();
      case 'search':
        if (typeof message.query !== 'string' || message.query.length > 500) return;
        state.threads.query = message.query.trim();
        state.threads.items = [];
        return loadThreads();
      case 'loadMore': return loadThreads(true);
      case 'newTab': return openNewTab();
      case 'openThread': return openThread(message.threadId);
      case 'stopThread': return stopThread(message.threadId, message.turnId);
      case 'renameThread': case 'togglePin': return mutateThread(message.type, message.threadId);
      case 'resetCredit': return resetCredit(message.creditId);
      default: return undefined;
    }
  }
  const workspaceSubscription = vscode.workspace?.onDidChangeWorkspaceFolders(() => {
    if (disposed) return;
    scopeGeneration++; generation++; listGeneration++;
    cursor = null; visitedCursors = new Set(); threadDirectories = new Map();
    listBusy = false; openings.clear();
    state.loading = false;
    state.threads = { items: [], loading: false, hasMore: false, query: state.threads.query };
    state.capabilities.pin = false; state.capabilities.open = false; state.capabilities.stop = false;
    emit();
    // 重新获取工作区范围，旧请求和确认框均不能向新项目回填或继续操作。
    return refresh();
  });
  if (workspaceSubscription) context.subscriptions?.push(workspaceSubscription);
  return { handleMessage, dispose() {
    disposed = true; generation++; listGeneration++; scopeGeneration++; accountGeneration++;
    if (accountTimer !== undefined) timers.clearInterval(accountTimer);
    if (runtimeTimer !== undefined) timers.clearInterval(runtimeTimer);
    workspaceSubscription?.dispose();
  } };
}

module.exports = { createSidebarController, normalizeLimits, normalizeThread, isWorkspacePath };
