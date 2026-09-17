'use strict';

const { randomUUID } = require('node:crypto');
const { createCompatibilityManager } = require('./compatibility-manager');
const { createSidebarViewProvider } = require('./sidebar-view');
const { createSidebarController } = require('./sidebar-controller');

/** 注册命令，复用官方界面；唯一查询参数让每次新建拥有不同资源地址。 */
function activate(context) {
  const vscode = require('vscode');
  context.subscriptions.push(createCompatibilityManager(vscode, context));

  async function openPanel(route, beside) {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official) {
      throw new Error('请先安装并启用官方 Codex 扩展（openai.chatgpt）。');
    }
    await official.activate();
    const uri = vscode.Uri.from({
      scheme: 'openai-codex',
      authority: 'route',
      path: route,
      query: `codexMultiTab=${randomUUID()}`,
    });
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'chatgpt.conversationEditor',
      {
        viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false,
      },
    );
  }

  async function openNewTab(beside) {
    try {
      await openPanel('/extension/panel/new', beside);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`无法打开 Codex 独立标签页：${detail}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codexMultiTab.newTab', () => openNewTab(false)),
    vscode.commands.registerCommand('codexMultiTab.newTabBeside', () => openNewTab(true)),
  );

  const sidebar = createSidebarViewProvider(vscode, context, message => controller.handleMessage(message));
  const controller = createSidebarController(vscode, context, {
    postState: state => sidebar.postState(state),
    openNewTab: () => openNewTab(false),
    openThreadTab: id => openPanel(`/local/${id}`, false),
  });
  context.subscriptions.push(sidebar, controller,
    vscode.window.registerWebviewViewProvider('codexMultiTab.sidebar', sidebar));
}

module.exports = { activate };
