# 开发与目录约定 / Development layout

本项目使用 CommonJS JavaScript，扩展宿主直接加载源码，无需编译。目录按运行职责划分；迁移目录不改变官方 Codex 接口、补丁生成内容或备份格式。

```text
codex-multi-tab/
├── package.json                  # 扩展清单、入口、命令及开发脚本
├── src/
│   ├── extension.js              # 激活、命令注册与模块装配
│   ├── compatibility/            # 官方扩展适配、校验与恢复
│   │   ├── compatibility-manager.js
│   │   ├── title-patch.js
│   │   ├── native-history-patch.js
│   │   └── sidebar-bridge-patch.js
│   └── sidebar/                  # 扩展宿主侧的会话、用量和 Webview 管理
│       ├── sidebar-controller.js
│       └── sidebar-view.js
├── media/sidebar/                # Webview 浏览器侧资源
│   ├── sidebar.js
│   └── sidebar.css
├── assets/                       # 图标和公开截图，保留已发布的引用路径
│   ├── icon.png
│   ├── toolbar-icon.png
│   └── screenshots/
├── test/                         # Node 原生测试及真实资产副本回归
├── scripts/                      # 语法检查、打包工具
├── docs/
│   ├── development.md            # 本文
│   └── local/                    # 本地验收记录，不进 Git 或 VSIX
├── dist/                         # 新构建的 VSIX，不进 Git 或 VSIX
│   └── archive/                  # 整理前已有的历史安装包，保留原文件
├── backups/                      # 旧手动补丁备份，不移动、不分发
├── title-patch.js                # 旧 CLI 路径兼容入口
├── README.md / README.en.md      # 中英文介绍及使用说明
├── CHANGELOG.md                  # 已发布版本记录
└── SUPPORT.md                    # 问题反馈与隐私说明
```

`dist/`、`backups/` 和 `docs/local/` 是按需生成的本地目录，新克隆不包含这些内容。根目录 `CLAUDE.md` 是本地开发约束，保持忽略。`package-lock.json` 不作为本次整理的一部分修改；扩展当前没有 npm 运行时依赖。

## 模块边界

- `src/extension.js` 负责接入 VS Code，并将打开标签、消息和状态回调连接起来。
- `src/sidebar/` 在扩展宿主中执行，负责项目范围、官方数据读取、会话操作及页面资源 URI。
- `media/sidebar/` 在 Webview 中执行，通过消息与宿主通信，不直接读取本地文件或调用 Node API。
- `src/compatibility/` 集中维护官方内部接口适配。未知资产仍拒绝修改；移文件时不要顺带修改经 `Function.toString()` 注入官方资产的函数体。
- `test/` 按能力保留现有测试文件，测试真实模块；需要官方文件的测试只在临时副本上应用和恢复补丁。

## 本地开发

检查和测试使用 Node.js 内置工具，不需要先安装 npm 依赖。打包工具 VSCE 4.0.0 要求 Node.js 22 或更高版本。

```sh
npm run check
npm test
npm run package
```

`npm run check` 递归检查 `src/`、`media/`、`scripts/`、`test/` 及根 CLI 入口的 JavaScript 语法，新增模块无需逐个添加到清单。`npm run package` 先运行检查和测试，再通过固定版本的 VSCE 打包到 `dist/<name>-<version>-<publisher>.vsix`，同名本地构建会被替换；历史包留在 `dist/archive/`。

## 打包与恢复

`.vscodeignore` 排除测试、开发脚本、文档目录、历史安装包、本地备份和开发约束。运行所需的 `src/`、`media/`、`assets/`、根 CLI 入口和扩展清单必须保留。中英文 README、变更日志和反馈指南随包提供。打包完成后核对 VSIX 内清单的 `publisher`、`main` 及资源文件；打包本身不会上传市场、安装扩展或重载窗口。

保留旧 CLI 用法：

```sh
node title-patch.js dry-run "<官方扩展安装目录>" "<备份目录>"
node title-patch.js restore "<官方扩展安装目录>" "<备份目录>"
```

省略备份参数时，CLI 始终使用项目根目录的 `backups/`，不随启动时工作目录改变。扩展运行时仍使用 VS Code `globalStorage/patch-backups/`；移动源码不移动或覆盖备份。恢复已安装增强时，按 README 先禁用辅助扩展并等待运行任务结束。

## English summary

The extension runs CommonJS source directly. `src/extension.js` wires commands and providers; `src/sidebar/` owns host-side state and messages; `media/sidebar/` contains browser-side UI; `src/compatibility/` owns audited native patches and restoration. Keep injected function bodies unchanged during file moves.

`assets/` paths stay stable for published icons and screenshots. Tests remain under `test/`. Development tools live in `scripts/`, and this guide lives in `docs/`. Local reports in `docs/local/`, packages in `dist/`, and legacy backups in `backups/` are excluded from Git and VSIX. Existing local packages were preserved under `dist/archive/`.

Run `npm run check`, `npm test`, or `npm run package`. Packaging requires Node.js 22+, runs both checks first, and uses pinned VSCE 4.0.0. Its output is `dist/<name>-<version>-<publisher>.vsix`; rebuilding replaces that local output. No publishing or installation occurs. Verify the packaged manifest and required runtime resources before release.

The root `title-patch.js` remains a compatibility entry point. Its default backup directory stays at the repository root, independent of the working directory. Runtime backups remain in VS Code global storage. Documentation-only or directory changes do not establish compatibility with future official Codex builds.
