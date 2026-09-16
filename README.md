# Codex Multi Tab

本地 VS Code 辅助扩展，在官方 Codex 界面之外增加独立标签页入口。复用官方扩展的登录、模型、工具与聊天界面。多开入口本身不修改官方扩展；0.2.0 另提供本地标题同步补丁，会修改官方扩展的两个 JavaScript 文件，不读取凭据或聊天记录。

这是社区辅助工具，与 OpenAI 无隶属关系。多标签聊天已通过本地真实界面验证；标题同步补丁目前通过代码审查和自动化测试，**真实界面验收尚未完成，属于实验功能**。

## 安装

先安装官方 Codex 扩展 `openai.chatgpt`，再从本仓库 [Releases](https://github.com/mofyer/codex-multi-tab/releases) 下载 VSIX，在 VS Code 执行 **Extensions: Install from VSIX...** 并选择下载的文件。

也可以克隆仓库后自行打包，命令见下方。VSIX 只包含多标签辅助扩展；可选标题补丁需要保留源码目录后另行应用。

## 使用

- 点击编辑器右上角的 **＋**（悬停显示「＋ Codex」），或 Codex 侧栏标题上的 **＋**。
- 命令面板执行 **＋ Codex：新建独立标签页**。
- macOS 快捷键：**⌘⌥⇧N**；Windows / Linux：**Ctrl+Alt+Shift+N**。
- 要同时显示两个对话，执行 **Codex：在右侧新建独立标签页**；也可以把现有标签拖到另一编辑器组。

每次调用生成不同的资源 URI，并关闭预览模式，因此不会复用先前的空白标签页。标签内的聊天由官方 Codex 扩展管理。

## 会话名同步（本地补丁）

安装辅助扩展本身不会自动修改官方文件。标题同步需在源码目录手动执行下列命令，把示例目录替换为 VS Code 实际启用的官方 Codex 安装目录：

```sh
npm run title:check -- "$HOME/.vscode/extensions/openai.chatgpt-26.5908.31748-darwin-arm64"
npm run title:apply -- "$HOME/.vscode/extensions/openai.chatgpt-26.5908.31748-darwin-arm64"
```

应用后重载需要生效的 VS Code 窗口。通过「＋ Codex」新建的标签会跟随官方页面中的会话标题变化，尚无标题时显示 Codex。只修改发出消息的辅助标签，侧栏和普通 Codex 标签不受影响。连续空白压为单个空格，保留中文和 Unicode 字符，最多显示 120 个字符。

补丁仅支持已核对文件哈希的 **26.5908.31748 / 26.908.40401**（本地 macOS ARM64 安装包）。版本、哈希或代码特征不匹配时拒绝修改，不承诺其他平台的发行文件兼容。原始文件及校验清单保存在本工具的 `backups/`，请保留该目录。备份不随 Git 仓库或 VSIX 分发。重复 apply 不会重复打补丁。

撤销标题补丁：

```sh
npm run title:restore -- "$HOME/.vscode/extensions/openai.chatgpt-26.5908.31748-darwin-arm64"
```

restore 会先校验当前文件和备份；如果官方文件又被更新或被其他工具修改，则拒绝覆盖。恢复后重载窗口。**卸载辅助扩展不会自动恢复官方文件**，需单独运行 restore。官方更新可能覆盖补丁，新版本需重新核对兼容性；工具不会自动重新打补丁。

## 兼容与边界

需要已安装并启用 `openai.chatgpt`。本扩展使用其内部 `openai-codex` URI 与 `chatgpt.conversationEditor` 编辑器类型；这不是 OpenAI 公布的稳定扩展 API，官方升级可能改变它们。

**重载恢复尚未通过真实环境验证。** 当前官方代码不会把新建标签的 `/extension/panel/new` 资源自动改成 `/local/{会话ID}`；重载窗口或重启 VS Code 后，标签可能恢复为空白新聊天。不要把空白标签恢复等同于聊天删除，已发送会话需从官方历史记录确认并重新打开。未发送的草稿请在关闭或重载前自行保留。本版本不承诺像 Claude 一样恢复每个标签所对应的会话。

## 本地检查与打包

```sh
npm run check
npm test
npx @vscode/vsce package
code --install-extension codex-multi-tab-0.2.0.vsix
```

安装后如果命令尚未出现，执行 VS Code 的「Developer: Reload Window」。卸载本辅助扩展可移除新增命令、按钮与快捷键；已应用的标题补丁需按上文单独恢复。

测试使用 VS Code API / DOM 替身验证 URI 独立、固定标签、分屏选项、错误分支、标题消息隔离及节流去重；本机存在对应官方版本时，再对临时副本验证补丁应用、幂等、外部修改保护与逐字节恢复，不复制官方源码进仓库。缺少对应安装包时，会明确跳过该版本的本地集成测试。测试不能替代官方界面的实际标题展示或重载恢复验收。
