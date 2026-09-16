'use strict';

const path = require('node:path');

/** 检查当前官方扩展，兼容时恢复增强；未知文件保持原样并提示。 */
function createCompatibilityManager(vscode, context, patcher = (...args) => require('./title-patch').patchExtension(...args)) {
  const backupRoot = path.join(context.globalStorageUri.fsPath, 'patch-backups');
  const notifications = new Set();
  let disposed = false;
  let requested = false;
  let running;
  let retryTimer;
  let busyIdentity;
  let busyRetries = 0;
  let busyExhausted = false;

  function notify(key, message, reload = false) {
    if (disposed || notifications.has(key)) return;
    notifications.add(key);
    // 提示不阻塞后续扩展更新检查；只有用户主动选择才重载窗口。
    const result = reload
      ? vscode.window.showInformationMessage(message, '重载窗口')
      : vscode.window.showWarningMessage(message);
    Promise.resolve(result).then(choice => {
      if (!disposed && reload && choice === '重载窗口') {
        return vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return undefined;
    }).catch(() => { notifications.delete(key); });
  }

  async function check() {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official?.extensionPath || disposed) return;
    const directory = official.extensionPath;
    const identity = `${directory}:${official.packageJSON?.version || ''}`;
    if (identity !== busyIdentity) {
      busyIdentity = identity;
      busyRetries = 0;
      busyExhausted = false;
    }
    if (busyExhausted) return;
    try {
      let result;
      try {
        result = await patcher(directory, 'dry-run', backupRoot);
      } catch (error) {
        const needsReapply = error?.code === 'CODEX_MULTI_TAB_REAPPLY_REQUIRED';
        if (!needsReapply || disposed) throw error;
        await patcher(directory, 'restore', backupRoot);
        if (disposed) return;
        result = await patcher(directory, 'dry-run', backupRoot);
      }
      if (disposed) return;
      if (result.status === 'already-applied') {
        busyRetries = 0;
        return;
      }
      if (result.status !== 'ready') throw new Error(`未知兼容检查结果：${result.status}`);
      await patcher(directory, 'apply', backupRoot);
      busyRetries = 0;
      notify(`${identity}:applied`, 'Codex Multi Tab 增强已适配当前官方扩展。请在运行中的任务结束后重载窗口生效。', true);
    } catch (error) {
      if (disposed) return;
      if (error?.code === 'CODEX_MULTI_TAB_PATCH_BUSY') {
        // 其他窗口持锁时合并更新事件，最多等待五次，避免并发覆盖和忙轮询。
        requested = false;
        if (busyRetries >= 5) {
          busyExhausted = true;
          notify(`${identity}:busy`, '其他 VS Code 窗口仍在更新 Codex Multi Tab 增强，请稍后重载窗口重新检查。');
        } else {
          busyRetries++;
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            requestCheck();
          }, 1000);
        }
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      notify(`${identity}:${detail}`, `Codex Multi Tab 暂未启用增强，官方功能仍可使用：${detail}`);
    }
  }

  function requestCheck() {
    if (disposed) return Promise.resolve();
    if (retryTimer) return running || Promise.resolve();
    requested = true;
    if (!running) {
      running = (async () => {
        while (requested && !disposed) {
          requested = false;
          await check();
        }
      })().finally(() => { running = undefined; });
    }
    return running;
  }

  const subscription = vscode.extensions.onDidChange(requestCheck);
  requestCheck();
  return {
    requestCheck,
    dispose() {
      disposed = true;
      requested = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      subscription.dispose();
    },
  };
}

module.exports = { createCompatibilityManager };
