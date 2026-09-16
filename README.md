# Codex Multi Tab

<img src="assets/icon.png" alt="Codex Multi Tab 图标" width="128" height="128">

VS Code 社区辅助扩展：独立 Codex 标签页、会话标题同步，以及原生历史面板增强。复用官方扩展的登录、模型、工具、聊天界面和历史数据，与 OpenAI 无隶属关系。

**English overview:** Open independent Codex editor tabs side by side, keep tab titles in sync, and rename or pin local conversations in the native history panel. This is an unofficial community extension. Native UI enhancements modify audited files in the official Codex extension, with backups and compatibility checks. Only the listed macOS ARM64 builds have been verified; future updates may require adaptation.

## 功能

- **独立标签与分屏**：每次新建独立 Codex 编辑器标签，可拖入不同编辑器组，同时查看多个对话。
- **会话标题同步**：标签名称随当前会话及重命名结果更新。
- **增强原生历史**：沿用官方搜索、列表和会话数据，支持本地会话置顶、取消置顶、重命名。
- **在当前标签继续历史任务**：选中历史会话后先提醒保存未发送内容，确认后替换当前标签内容；提醒不会自动保存草稿。
- **新标签工具栏**：空白聊天也可使用原生历史、设置和新聊天入口；新建标签按钮使用适配小尺寸的透明背景图标。

## 安装与使用

![独立 Codex 标签与左右分屏实机截图](assets/screenshots/independent-tabs.png)

图中为三个独立空白标签，其中两个在左右编辑器组同时显示；未包含真实会话内容。

需要 VS Code **1.90.0 或更新版本**，并安装官方 Codex 扩展 **`openai.chatgpt`**、完成其登录。当前实机验证范围见下文兼容说明。

也可从 [GitHub Releases](https://github.com/mofyer/codex-multi-tab/releases) 下载 VSIX，在命令面板执行 **Extensions: Install from VSIX...** 安装。首次应用增强后，保存草稿、等待运行中的任务结束，再按提示重载当前窗口。

- 编辑器或 Codex 侧栏右上角的本扩展图标：新建独立 Codex 标签。
- 命令 **Codex：新建独立标签页**；快捷键 macOS **⌘⌥⇧N**，Windows / Linux **Ctrl+Alt+Shift+N**。
- 命令 **Codex：在右侧新建独立标签页**：分屏同时查看两个对话。
- 历史会话使用聊天页面内的**原生历史按钮**，不另建 VS Code 选择框。

打开原生历史面板后，在会话行使用置顶按钮或操作菜单进行管理。只有创建会话后，聊天标题旁才显示需要会话对象的操作菜单。取消切换提醒会保留当前标签内容；继续切换不会另开一个标签。

## 官方更新与兼容

### 从旧本地安装迁移

市场版完整 ID 为 `mofyer.codex-multi-tab`，旧本地版为 `yafan-local.codex-multi-tab`，VS Code 会将它们视为两个扩展。旧版用户应先禁用旧扩展，保存草稿并等待任务结束，然后退出所有 VS Code 窗口。将旧扩展 `globalStorage` 下的整个 `patch-backups/` 复制到新扩展对应的 `globalStorage` 目录，保留旧备份，再安装并启用市场版；目标目录若已有备份，不要直接覆盖。不要同时启用新旧版本。macOS 默认存储根目录为 `~/Library/Application Support/Code/User/globalStorage/`，两个扩展目录名分别是上述完整 ID。

首次安装用户无需迁移。本扩展尚未实现跨发布者 ID 自动迁移备份。

新建独立标签使用 VS Code 编辑器 API 和官方内部 URI；原生界面增强需要修改官方扩展的少量 JavaScript 资产，没有可用的官方公开扩展 API。

辅助扩展启动及官方扩展变化时，自动检查实际安装目录，并为兼容资产恢复增强。不会自动重载窗口或停止运行中的任务；应用后按提示，在任务结束并保存草稿后重载当前窗口。

- 已验证资产：官方 **26.5908.31748 / 26.908.40401** 的 **macOS ARM64** 安装包。Windows、Linux、macOS Intel 等平台尚未验证，不承诺原生增强可用。
- 发行版本号变化但实际加载的已审计资产字节完全一致时，可以复用兼容配置。
- 文件哈希或内部结构改变时拒绝继续修改并提示；**不保证所有未来版本自动兼容**。基础新建标签也依赖官方内部 URI，其变化同样可能需要适配。
- 备份位于本辅助扩展的 VS Code `globalStorage` 下 `patch-backups/`，与辅助扩展安装目录分离，升级辅助扩展不会覆盖备份。
- 改名、置顶复用原生接口与状态，不维护另一套历史记录。各平台仍受官方服务能力与同步机制约束。

## 恢复原始文件

先禁用 Codex Multi Tab，防止再次自动应用；保留源码或已安装扩展目录中的脚本，执行：

```sh
node title-patch.js restore "<官方扩展实际安装目录>" "<Codex Multi Tab globalStorage 下的 patch-backups 目录>"
```

旧版手动补丁使用源码目录下 `backups/`，恢复命令无需第三个参数：

```sh
npm run title:restore -- "<官方扩展实际安装目录>"
```

恢复会校验备份及当前文件，拒绝覆盖其他工具或官方更新造成的未知改动。恢复后重载窗口。卸载辅助扩展不会自动恢复官方文件；备份不随 Git 仓库或 VSIX 分发。

## 已知边界

- 原生历史和标题增强仍为实验功能；自动化测试及代码审查不能代替真实界面验收。
- 原生服务可能提示某会话已在其他应用打开；本扩展不会绕过会话占用保护。
- 尚未实现重启后每个辅助标签恢复到对应会话。原始新建 URI 可能让标签恢复为空白聊天，已发送会话仍需从历史打开；未发送草稿须自行保存。
- 不改变登录、鉴权、模型或工具权限。新标签的引导状态会等官方查询完成再判断，真正首次使用仍保留引导。

## 支持与反馈

问题请提交到 [GitHub Issues](https://github.com/mofyer/codex-multi-tab/issues)。请按[支持说明](SUPPORT.md)附上扩展版本、系统及复现步骤，勿上传令牌、真实会话内容或补丁备份。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 开发与打包

```sh
npm run check
npm test
npx @vscode/vsce package
code --install-extension codex-multi-tab-0.3.3.vsix
```

测试覆盖标签隔离、原生增强、兼容检测、哈希校验、应用失败回滚和逐字节恢复。本机缺少对应官方安装包时，相关实包测试明确标记跳过。

开发约束：用户要求增强官方功能时，优先复用原生组件、接口和状态，不另建平行面板；图标需同时核对扩展清单与工具栏命令配置。
