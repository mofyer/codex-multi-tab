'use strict';

const { randomBytes } = require('node:crypto');

/** 创建独立侧栏；扩展负责注册视图和处理业务消息。 */
function createSidebarViewProvider(vscode, context, onMessage) {
  let currentView;
  let lastState;
  let disposed = false;
  let viewDisposables = [];

  function clearView() {
    for (const disposable of viewDisposables) disposable.dispose();
    viewDisposables = [];
    currentView = undefined;
  }

  function sendState() {
    if (disposed || !currentView || lastState === undefined) return Promise.resolve(false);
    try {
      return Promise.resolve(currentView.webview.postMessage({ type: 'state', state: lastState }))
        .catch(() => false);
    } catch {
      // 视图销毁可能与异步刷新同时发生。
      return Promise.resolve(false);
    }
  }

  return {
    resolveWebviewView(view) {
      if (disposed) return;
      clearView();
      currentView = view;
      const webview = view.webview;
      const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'sidebar');
      webview.options = { enableScripts: true, localResourceRoots: [media] };
      const nonce = randomBytes(24).toString('base64');
      const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
      const script = escape(webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js')));
      const style = escape(webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css')));
      viewDisposables.push(webview.onDidReceiveMessage((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.type === 'ready') void sendState();
        return onMessage(message);
      }));
      viewDisposables.push(view.onDidDispose(() => {
        if (currentView === view) clearView();
      }));
      webview.html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}'; img-src ${escape(webview.cspSource)}; base-uri 'none'; form-action 'none';">
  <link rel="stylesheet" href="${style}">
  <title>Codex 会话管理</title>
</head>
<body>
  <main id="sidebar">
    <details id="account-panel" open>
      <summary><span>账号与用量</span><span class="summary-hint">官方账户</span></summary>
      <div class="account-content">
        <div class="account-heading"><div class="account-identity"><strong id="account-name">正在读取账号…</strong><span id="account-plan">正在读取套餐…</span></div><button id="refresh" class="icon-button" title="刷新账号、用量与会话" aria-label="刷新账号、用量与会话">↻</button></div>
        <p id="account-expiry" class="notice" hidden></p>
        <p id="account-note" class="notice" hidden></p>
        <div id="usage"></div>
        <section class="credits-section" aria-labelledby="credits-heading"><h2 id="credits-heading">额度重置卡 <span id="credits-count" class="credits-count" aria-live="polite">—</span></h2><div id="credits"></div></section>
      </div>
    </details>
    <p id="global-error" class="notice error" role="status" hidden></p>
    <section class="threads-section" aria-labelledby="threads-heading">
      <div class="section-heading"><h1 id="threads-heading">会话管理</h1><button id="new-tab" class="primary-button">＋ 新建</button></div>
      <label class="search-label" for="search">搜索会话</label>
      <input id="search" type="search" placeholder="搜索会话…" autocomplete="off" spellcheck="false">
      <p id="threads-status" class="notice" role="status" hidden></p>
      <div id="thread-list"></div>
      <button id="load-more" class="load-more" hidden>加载更多</button>
    </section>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    },
    postState(state) {
      if (disposed) return Promise.resolve(false);
      lastState = state;
      return sendState();
    },
    dispose() {
      disposed = true;
      lastState = undefined;
      clearView();
    },
  };
}

module.exports = { createSidebarViewProvider };
