'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, 'dist');
fs.mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `${manifest.name}-${manifest.version}-${manifest.publisher}.vsix`);
// 固定打包工具版本；不安装为运行时依赖，也不触碰发布凭据。
const result = spawnSync('npx', ['--yes', '@vscode/vsce@4.0.0', 'package', '--out', output], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
