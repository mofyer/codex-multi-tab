'use strict';

const { createAccountStore } = require('./account-store');
const PENDING = 'codexMultiTab.pendingAccountSwitch';
const ACTIONS = new Set(['saveAccount', 'addAccount', 'switchAccount', 'renameAccount', 'removeAccount', 'cancelAccountLogin']);
const environmentMessages = {
  'bridge-outdated': '当前窗口仍在使用旧版连接桥。请保存草稿、结束任务后重载窗口，再点击刷新。',
  remote: '当前是远程环境，多账号暂仅支持本地 Codex。',
  wsl: '当前 Codex 运行在 WSL 中，多账号暂不支持此环境。',
  'local-host-unavailable': '无法确认官方本地连接，请重载窗口后重试。',
  'home-unavailable': '无法确认官方 Codex 的本地存储目录。',
  'auth-storage-unsupported': '官方有效配置使用了非文件式凭据存储；多账号暂仅支持 file 模式。',
  'login-method-restricted': '官方配置限制了登录方式，当前不允许 ChatGPT 账号切换。',
  'workspace-restriction-invalid': '无法识别官方工作区限制，本次未启用账号切换。',
  'config-unavailable': '暂时无法读取官方有效配置，请刷新重试。',
  'environment-timeout': '官方环境检查超时，请刷新重试。',
  CODEX_MULTI_TAB_ACCOUNT_BUSY: '另一个窗口正在管理账号，请稍后刷新；若持续出现，请按多账号说明检查遗留操作锁。',
  CODEX_MULTI_TAB_ACCOUNT_UNSUPPORTED: '本地凭据存储环境无法安全确认，请检查目录或官方凭据存储方式。',
  CODEX_MULTI_TAB_ACCOUNT_STORAGE: '无法访问账号安全存储或本地目录，请检查系统权限后刷新。',
  CODEX_MULTI_TAB_ACCOUNT_IDENTITY: '当前登录身份已变化或无法核对，请刷新账号后重试。',
  CODEX_MULTI_TAB_ACCOUNT_CHANGED: '登录文件已被其他操作更新，本次未覆盖，请刷新后重试。',
  CODEX_MULTI_TAB_ACCOUNT_INVALID_AUTH: '登录凭据格式无法安全识别，请先在官方 Codex 中重新登录。',
  CODEX_MULTI_TAB_ACCOUNT_NOT_FOUND: '已保存的账号不存在，请刷新账号列表。',
};

/** Credentials stay in the extension host. The webview receives only an explicit metadata projection. */
function createAccountController(vscode, context, {
  bridge, changed, refresh, waitForAccount, canStart, timers = globalThis, storeFactory = createAccountStore,
}) {
  let disposed = false, busy = false, login = null, loginTimer, loginFlight, recoveryTimer;
  let store, home, supported = false, account = null, environmentInfo, revision = 0;
  let items = [], message = '正在检查多账号支持…';
  const emit = () => { if (!disposed) changed(snapshot()); };
  const snapshot = () => ({ supported, busy, pendingLogin: Boolean(login), message,
    items: items.map(item => ({ id: item.id, email: item.email, label: item.label, planType: item.planType,
      isCurrent: Boolean(account?.accountId && item.accountId === account.accountId && item.email === account.email) })) });
  const error = async value => { if (!disposed) return vscode.window.showErrorMessage(value); };
  const current = async () => {
    const value = await bridge({ action: 'rpc', method: 'account/read', params: { refreshToken: false } });
    if (!value || !Object.hasOwn(value, 'account')) throw new Error('account');
    if (value.account == null) return null;
    if (value.account.type !== 'chatgpt') throw new Error('account');
    const limits = await bridge({ action: 'rpc', method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
    return { ...value.account, accountId: limits?.accountId };
  };
  async function environment() {
    const status = await bridge({ action: 'status' });
    if (!status?.capabilities?.accounts) throw Object.assign(new Error('unsupported'), { code: 'bridge-outdated' });
    const env = await bridge({ action: 'accountEnvironment' });
    if (!env?.supported || typeof env.home !== 'string') throw Object.assign(new Error('unsupported'), {
      code: Object.hasOwn(environmentMessages, env?.reason) ? env.reason : 'local-host-unavailable',
    });
    environmentInfo = env;
    if (home !== env.home || !store) {
      home = env.home;
      store = storeFactory(context, { home, readEnvironment: () => bridge({ action: 'accountEnvironment' }) });
    }
    await store.checkSupport();
    supported = true;
  }
  async function update(value) {
    if (disposed || busy || login) return;
    const token = ++revision;
    account = value;
    try {
      await environment();
      const rows = await store.list();
      if (disposed || busy || login || token !== revision) return;
      items = rows;
      if (message.startsWith('正在检查') || message.startsWith('多账号暂不可用')) message = '';
      const pending = context.globalState?.get(PENDING);
      if (pending && pending.home === home) {
        const target = items.find(item => item.id === pending.id);
        if (target && account?.accountId === target.accountId && account?.email === target.email) {
          message = '账号已切换，用量已重新读取。';
          await context.globalState.update(PENDING, undefined);
        } else message = '尚未确认目标账号生效，请在官方 Codex 检查登录后刷新；必要时重新登录。';
      }
    } catch (cause) {
      if (disposed || busy || login || token !== revision) return;
      supported = false;
      items = [];
      message = `多账号暂不可用：${Object.hasOwn(environmentMessages, cause?.code)
        ? environmentMessages[cause.code] : '官方连接检查失败，请刷新或重载窗口后重试。'}`;
    }
    emit();
  }
  async function preflight() {
    const result = await bridge({ action: 'accountSwitchPreflight' });
    if (result?.safe !== true) {
      message = '请先结束所有 Codex 标签中的运行任务后再切换或添加账号；无法确认运行状态时不会继续。';
      emit();
      return false;
    }
    return true;
  }
  function clearLogin() {
    login = null;
    if (loginTimer !== undefined) timers.clearInterval(loginTimer);
    loginTimer = undefined;
  }
  function recoverCancelledReload(staged) {
    // A cancelled VS Code save/reload dialog resolves the command without unloading us.
    // A completed reload disposes this timer; a live host restores its previous login.
    recoveryTimer = timers.setInterval(() => {
      timers.clearInterval(recoveryTimer); recoveryTimer = undefined;
      if (disposed) return;
      void (async () => {
        try {
          const restored = await staged.rollback();
          message = restored ? '窗口未重载，已恢复原登录缓存。保存草稿后可再次切换。'
            : '窗口未重载，登录缓存已有其他变化。请检查官方登录后刷新。';
          await context.globalState.update(PENDING, undefined);
        } catch { message = '窗口未重载且未能恢复登录缓存，请检查官方登录后再操作。'; }
        busy = false;
        emit();
        if (!disposed) await refresh();
      })();
    }, 15_000);
    recoveryTimer?.unref?.();
  }
  async function pollLogin() {
    if (disposed || !login || loginFlight || busy) return;
    const pending = login;
    loginFlight = (async () => {
      try {
        const result = await bridge({ action: 'accountLoginStatus', loginId: pending.id });
        if (disposed || login !== pending || pending.cancelled) return;
        if (result?.status === 'pending' && Date.now() < pending.expires) return;
        if (result?.success !== true) {
          await bridge({ action: 'cancelAccountLogin', loginId: pending.id });
          message = '登录未完成或已过期，当前已保存的账号仍可使用。';
        } else {
          const value = await current();
          if (disposed || login !== pending || pending.cancelled) return;
          await store.saveCurrent(value);
          message = '账号已登录并安全保存。';
        }
      } catch {
        if (disposed || login !== pending || pending.cancelled) return;
        try { await bridge({ action: 'cancelAccountLogin', loginId: pending.id }); }
        catch {
          message = '官方登录状态暂不可用，正在等待确认；可重试取消登录。';
          emit();
          return;
        }
        message = '无法确认登录或保存结果，已停止等待登录；请在官方 Codex 检查后保存当前账号。';
      }
      if (disposed || login !== pending || pending.cancelled) return;
      clearLogin();
      emit();
      if (!disposed) await refresh();
    })();
    try { await loginFlight; } finally { loginFlight = null; }
  }
  async function handle(action, id) {
    if (!ACTIONS.has(action)) return false;
    if (disposed || busy || !canStart() || (login && action !== 'cancelAccountLogin')) return true;
    if (['switchAccount', 'renameAccount', 'removeAccount'].includes(action)
      && (typeof id !== 'string' || !items.some(item => item.id === id))) return true;
    busy = true;
    revision++;
    emit();
    let reloading = false, staged;
    try {
      await waitForAccount();
      if (disposed) return true;
      if (action === 'cancelAccountLogin') {
        if (login) {
          const pending = login;
          pending.cancelled = true;
          try { await bridge({ action: 'cancelAccountLogin', loginId: pending.id }); }
          catch (cause) { pending.cancelled = false; throw cause; }
          clearLogin();
          if (loginFlight) await loginFlight;
          message = '已取消添加账号。';
        }
      } else {
        await environment();
        if (disposed) return true;
        if (action === 'renameAccount') {
          const item = items.find(row => row.id === id);
          const label = await vscode.window.showInputBox({ title: '账号备注', value: item.label || item.email,
            validateInput: value => !value.trim() || value.trim().length > 60 ? '请输入 1–60 个字符。' : undefined });
          if (!disposed && label?.trim() && label.trim().length <= 60) await store.rename(id, label.trim());
        } else if (action === 'removeAccount') {
          const item = items.find(row => row.id === id);
          const choice = await vscode.window.showWarningMessage(`移除已保存的账号“${item.label || item.email}”？当前登录不会退出。`, { modal: true }, '移除账号');
          if (!disposed && choice === '移除账号') await store.remove(id);
        } else {
          if (action !== 'saveAccount' && !await preflight()) return true;
          const value = await current();
          if (disposed) return true;
          if (action === 'saveAccount') {
            await store.saveCurrent(value);
            message = '当前账号已安全保存。';
          } else if (action === 'addAccount') {
            // Save the latest refresh credential before a successful browser login replaces it.
            if (value) await store.saveCurrent(value);
            if (disposed) return true;
            const result = await bridge({ action: 'accountLogin' });
            if (typeof result?.loginId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.loginId)) throw new Error('login');
            login = { id: result.loginId, expires: Date.now() + 10 * 60_000 };
            if (disposed) {
              await bridge({ action: 'cancelAccountLogin', loginId: login.id });
              clearLogin();
              return true;
            }
            const url = new URL(result.authUrl);
            if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) throw new Error('url');
            if (!await vscode.env.openExternal(vscode.Uri.parse(url.href))) throw new Error('browser');
            if (disposed) {
              if (login) await bridge({ action: 'cancelAccountLogin', loginId: login.id });
              clearLogin();
              return true;
            }
            message = '请在浏览器登录另一个账号；完成后自动保存。登录期间请勿启动新任务。';
            loginTimer = timers.setInterval(() => { void pollLogin(); }, 1500);
            loginTimer?.unref?.();
          } else if (action === 'switchAccount') {
            const target = items.find(item => item.id === id);
            if (environmentInfo?.forcedWorkspaceIds?.length && !environmentInfo.forcedWorkspaceIds.includes(target.accountId)) throw new Error('workspace');
            // Persist only a non-secret target marker. The reloaded extension verifies real identity.
            await context.globalState.update(PENDING, { id, home });
            if (disposed || !await preflight()) {
              await context.globalState.update(PENDING, undefined);
              return true;
            }
            staged = await store.stageSwitch(id, value, async () => {
              if (disposed || !await preflight()) throw new Error('cancelled');
            });
            if (staged.cleanupWarning) throw new Error('lock-cleanup');
            if (disposed) { await staged.rollback(); return true; }
            if (staged.changed) {
              if (!await preflight()) {
                await staged.rollback();
                await context.globalState.update(PENDING, undefined);
                return true;
              }
              if (disposed) { await staged.rollback(); return true; }
              message = '正在重载窗口以切换账号…';
              emit();
              await vscode.commands.executeCommand('workbench.action.reloadWindow');
              reloading = true;
              if (!disposed) recoverCancelledReload(staged);
            } else {
              await context.globalState.update(PENDING, undefined);
              message = '已经是当前账号。';
            }
          }
        }
      }
    } catch (cause) {
      message = Object.hasOwn(environmentMessages, cause?.code) ? environmentMessages[cause.code]
        : '账号操作未完成。请确认本地文件式 ChatGPT 登录、系统安全存储和官方连接可用，再刷新重试。';
      if (staged) {
        try { await staged.rollback(); } catch { message = '切换未完成，缓存已发生变化；请在官方 Codex 检查当前登录。'; }
      }
      if (action === 'switchAccount') await context.globalState?.update(PENDING, undefined).catch(() => undefined);
      if (action === 'addAccount' && login) {
        try {
          await bridge({ action: 'cancelAccountLogin', loginId: login.id });
          clearLogin();
        } catch {
          message = '暂未确认官方登录已取消，请重试取消；确认前暂停其他账号操作。';
          if (!disposed && loginTimer === undefined) {
            loginTimer = timers.setInterval(() => { void pollLogin(); }, 1500);
            loginTimer?.unref?.();
          }
        }
      }
      // VS Code resolves this only when the notification closes; it must not hold busy.
      void error(message).catch(() => undefined);
    } finally {
      if (!reloading) busy = false;
      emit();
      if (!disposed && !reloading && !login) await refresh();
    }
    return true;
  }
  return { update, handle, get busy() { return busy || Boolean(login); }, dispose() {
    disposed = true;
    revision++;
    if (recoveryTimer !== undefined) timers.clearInterval(recoveryTimer);
    if (login) void bridge({ action: 'cancelAccountLogin', loginId: login.id }).catch(() => undefined);
    clearLogin();
  } };
}

module.exports = { createAccountController };
