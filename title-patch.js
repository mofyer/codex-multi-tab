'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PATCH_VERSION = require('./package.json').version;
const { getNativePatchFiles, getNativeDependencies } = require('./native-history-patch');
const HOST_ANCHOR = 'case"navigate-in-new-editor-tab":{let n=pI(r.path);';
const PROFILES = {
  '26.5908.31748': {
    asset: 'webview/assets/app-initial-972655adec02.js',
    api: 'qf',
    nuxAnchor: 'function lQn(){let{data:e,isLoading:t}=$g(xr.NUX_2025_09_15),{authMethod:n}=fu();',
    webHash: '919609dae54b1918456a1039eef6146dee869ec86061b7e845bc919e6fdbb5d5',
  },
  '26.908.40401': {
    asset: 'webview/assets/app-initial-a190b16fc630.js',
    api: 'Jf',
    nuxAnchor: 'function pQn(){let{data:e,isLoading:t}=n_(xr.NUX_2025_09_15),{authMethod:n}=pu();',
    webHash: '50b1a443400ba2f7ac0be53c56536a3e145bccfff0e2f456f100850133a01683',
  },
};
const HOST_HASH = '820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f';

// 仅按消息来源定位辅助扩展面板，侧栏和其他编辑器不参与更新。
function updatePanelTitle(host, webview, title) {
  const panel = host.findPanelByWebview(webview);
  const route = panel && host.editorPanels.get(panel)?.initialRoute;
  if (typeof route !== 'string' || !route.includes('?')) return;
  const query = new URLSearchParams(route.slice(route.indexOf('?') + 1));
  if (!query.get('codexMultiTab') || typeof title !== 'string') return;
  const normalized = title.replace(/\s+/gu, ' ').trim();
  panel.title = Array.from(!normalized || normalized === 'ChatGPT' ? 'Codex' : normalized).slice(0, 120).join('');
}

// 会话标题由官方页面维护；合并 head 更新，避免每个 token 都向宿主发消息。
function observeTitle(api, doc = document, win = window) {
  const route = doc.querySelector('meta[name="initial-route"]')?.content;
  if (typeof route !== 'string' || !route.includes('?')) return;
  if (!new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('codexMultiTab')) return;
  let previous;
  let timer;
  const send = () => {
    timer = undefined;
    const normalized = doc.title.replace(/\s+/gu, ' ').trim();
    const title = Array.from(!normalized || normalized === 'ChatGPT' ? 'Codex' : normalized).slice(0, 120).join('');
    if (title !== previous) {
      api.postMessage({ type: 'codex-multi-tab-title', title });
      previous = title;
    }
  };
  const observer = new win.MutationObserver(() => {
    if (timer === undefined) timer = win.setTimeout(send, 100);
  });
  observer.observe(doc.head, { subtree: true, childList: true, characterData: true });
  send();
  win.addEventListener('pagehide', () => {
    observer.disconnect();
    if (timer !== undefined) win.clearTimeout(timer);
  }, { once: true });
}

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('补丁特征不唯一或缺失，拒绝修改');
  return source.replace(anchor, () => replacement);
}

// 新面板查询尚未启动时 isLoading 仍为 false；等待读取成功才判断首次引导。
function waitForOnboardingState(status, error, doc = document) {
  const route = doc.querySelector('meta[name="initial-route"]')?.content;
  if (typeof route !== 'string' || !route.includes('?')) return false;
  if (!new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('codexMultiTab')) return false;
  if (status === 'error') throw error;
  return status !== 'success';
}

function transformHost(source) {
  return replaceOnce(source, HOST_ANCHOR,
    `case"codex-multi-tab-title":{(${updatePanelTitle.toString()})(this,e,r.title);break;}${HOST_ANCHOR}`);
}

function transformWebview(source, api) {
  const anchor = `${api}=acquireVsCodeApi()`;
  const profile = Object.values(PROFILES).find(item => item.api === api);
  if (!profile) throw new Error('未知 webview 补丁配置，拒绝修改');
  const withTitle = replaceOnce(source, anchor, `${anchor};(${observeTitle.toString()})(${api})`);
  const nuxReplacement = profile.nuxAnchor.replace('isLoading:t}', 'isLoading:t,status:codexNuxStatus,error:codexNuxError}')
    + `if((${waitForOnboardingState.toString()})(codexNuxStatus,codexNuxError))return;`;
  return replaceOnce(withTitle, profile.nuxAnchor, nuxReplacement);
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// 发行版本号可变化；仅当实际加载的已审计资产字节完全一致时复用兼容配置。
function resolveProfileVersion(root, version, manifest, checkDependencies) {
  if (PROFILES[version]) return version;
  const htmlFile = path.join(root, 'webview/index.html');
  const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
  const matches = Object.entries(PROFILES).filter(([candidate, profile]) => {
    if (!html.includes(`"./${profile.asset.slice('webview/'.length)}"`)) return false;
    const files = [
      { file: 'out/extension.js', originalHash: HOST_HASH },
      { file: profile.asset, originalHash: profile.webHash },
      ...getNativePatchFiles(candidate),
      ...(checkDependencies ? getNativeDependencies(candidate) : []),
    ];
    return files.every(entry => {
      const file = path.join(root, entry.file);
      if (!fs.existsSync(file)) return false;
      const currentHash = hash(fs.readFileSync(file));
      if (currentHash === entry.originalHash) return true;
      const saved = Array.isArray(manifest?.files) ? manifest.files.find(item => item.file === entry.file) : undefined;
      return saved?.originalHash === entry.originalHash && saved.patchedHash === currentHash;
    });
  });
  if (matches.length !== 1) throw new Error('官方版本的资产尚不兼容，保留官方原功能；请更新 Codex Multi Tab');
  return matches[0][0];
}

// 先验证所有文件，再写入同目录临时文件并替换；保留原权限。
function replaceFile(file, bytes, expectedHash) {
  if (hash(fs.readFileSync(file)) !== expectedHash) throw new Error(`文件已被其他进程修改：${file}`);
  const temporary = `${file}.codex-title-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: fs.statSync(file).mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function patchExtensionUnlocked(directory, action, backupRoot) {
  if (!['dry-run', 'apply', 'restore'].includes(action)) throw new Error('操作必须为 dry-run、apply 或 restore');
  const root = fs.realpathSync(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.publisher !== 'openai' || pkg.name !== 'chatgpt') throw new Error('不支持此官方扩展，拒绝修改');
  const backup = path.join(backupRoot, `${pkg.version}-${hash(Buffer.from(root)).slice(0, 16)}`);
  const manifestFile = path.join(backup, 'manifest.json');
  const savedManifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : undefined;
  // 尚未重载的旧窗口不能把其他窗口刚安装的新版增强恢复成旧实现。
  if (savedManifest?.patchVersion !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(savedManifest.patchVersion)) throw new Error('备份中的辅助扩展版本无效，拒绝修改');
    const saved = savedManifest.patchVersion.split('.').map(Number);
    const current = PATCH_VERSION.split('.').map(Number);
    const difference = saved.findIndex((part, index) => part !== current[index]);
    if (difference >= 0 && saved[difference] > current[difference]) {
      throw Object.assign(new Error('其他窗口已安装新版增强，请重载当前窗口后再操作'), { code: 'CODEX_MULTI_TAB_NEWER_PATCH_PRESENT' });
    }
  }
  const profileVersion = resolveProfileVersion(root, pkg.version, savedManifest, action !== 'restore');
  const profile = PROFILES[profileVersion];
  if (action !== 'restore') {
    for (const dependency of getNativeDependencies(profileVersion)) {
      const file = path.join(root, dependency.file);
      if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== dependency.originalHash) {
        throw new Error(`原生界面依赖不兼容，拒绝修改：${dependency.file}`);
      }
    }
  }
  const patches = [
    { file: 'out/extension.js', originalHash: HOST_HASH, transform: transformHost },
    { file: profile.asset, originalHash: profile.webHash, transform: source => transformWebview(source, profile.api) },
  ];
  for (const native of getNativePatchFiles(profileVersion)) {
    const existing = patches.find(patch => patch.file === native.file);
    if (!existing) patches.push(native);
    else {
      if (existing.originalHash !== native.originalHash) throw new Error('同一资产的原件哈希配置冲突');
      const before = existing.transform;
      existing.transform = source => native.transform(before(source));
    }
  }
  const expectedFiles = patches.map(patch => patch.file);
  if (fs.existsSync(backup)) {
    const manifest = savedManifest;
    // 旧版只修改前两个文件，保留其恢复路径以便安全升级组合补丁。
    if (!manifest || manifest.root !== root || manifest.version !== pkg.version || manifest.format !== 1
      || !Array.isArray(manifest.files) || ![2, expectedFiles.length].includes(manifest.files.length)) throw new Error('备份清单不匹配，拒绝修改');
    const entries = manifest.files.map((entry, index) => {
      if (entry.file !== expectedFiles[index] || entry.backup !== `${index}.original`
        || entry.originalHash !== patches[index].originalHash) throw new Error('备份路径或原件哈希不匹配，拒绝修改');
      const original = fs.readFileSync(path.join(backup, entry.backup));
      if (hash(original) !== entry.originalHash) throw new Error('备份内容校验失败');
      const file = path.join(root, entry.file);
      const currentHash = hash(fs.readFileSync(file));
      if (currentHash !== entry.patchedHash && currentHash !== entry.originalHash) throw new Error(`文件已变化，拒绝覆盖：${entry.file}`);
      return { ...entry, original, file, currentHash };
    });
    if (action === 'restore') {
      // 先撤销引用新增导出的页面，再恢复提供导出的入口文件。
      for (const entry of [...entries].reverse()) {
        if (entry.currentHash !== entry.originalHash) replaceFile(entry.file, entry.original, entry.currentHash);
      }
      fs.rmSync(backup, { recursive: true });
      return { status: 'restored', version: pkg.version, files: entries.map(entry => entry.file) };
    }
    for (const patch of patches.slice(entries.length)) {
      const file = path.join(root, patch.file);
      if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== patch.originalHash) {
        throw new Error(`新增补丁资产不兼容，保留已有增强：${patch.file}`);
      }
    }
    if (entries.length !== patches.length || entries.some((entry, index) => entry.patchedHash
      !== hash(Buffer.from(patches[index].transform(entry.original.toString('utf8')))))) {
      throw Object.assign(new Error('发现旧版本补丁，请先 restore 再 apply'), { code: 'CODEX_MULTI_TAB_REAPPLY_REQUIRED' });
    }
    if (!entries.every(entry => entry.currentHash === entry.patchedHash)) throw Object.assign(new Error('发现未完成的补丁，请先 restore 再 apply'), { code: 'CODEX_MULTI_TAB_REAPPLY_REQUIRED' });
    return { status: 'already-applied', version: pkg.version, files: expectedFiles };
  }
  if (action === 'restore') return { status: 'not-applied', version: pkg.version };
  const entries = patches.map((patch, index) => {
    const relative = patch.file;
    const file = path.join(root, relative);
    const original = fs.readFileSync(file);
    const originalHash = hash(original);
    if (originalHash !== patch.originalHash) throw new Error(`官方文件哈希不匹配，拒绝修改：${relative}`);
    const source = original.toString('utf8');
    const patched = Buffer.from(patch.transform(source));
    return { file: relative, backup: `${index}.original`, originalHash, patchedHash: hash(patched), original, patched };
  });
  if (action === 'dry-run') return { status: 'ready', version: pkg.version, files: expectedFiles };
  fs.mkdirSync(backupRoot, { mode: 0o700, recursive: true });
  const staging = fs.mkdtempSync(path.join(backupRoot, '.title-backup-'));
  try {
    for (const entry of entries) fs.writeFileSync(path.join(staging, entry.backup), entry.original, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ format: 1, root, version: pkg.version, patchVersion: PATCH_VERSION, files: entries.map(({ original, patched, ...entry }) => entry) }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, backup);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
  }
  const written = [];
  try {
    for (const entry of entries) {
      replaceFile(path.join(root, entry.file), entry.patched, entry.originalHash);
      written.push(entry);
    }
  } catch (error) {
    const failures = [];
    // 仅撤销本次成功写入且尚未被他人修改的文件。
    for (const entry of written.reverse()) {
      try { replaceFile(path.join(root, entry.file), entry.original, entry.patchedHash); }
      catch (rollbackError) { failures.push(rollbackError.message); }
    }
    if (failures.length === 0) fs.rmSync(backup, { recursive: true });
    throw new Error(failures.length ? `应用失败，备份已保留；回滚失败：${failures.join('; ')}；原错误：${error.message}` : `应用失败，已撤销本次修改：${error.message}`);
  }
  return { status: 'applied', version: pkg.version, files: expectedFiles };
}

// 不同 VS Code 窗口共享同一备份根目录；写入期间禁止另一个进程恢复或应用。
function patchExtension(directory, action = 'dry-run', backupRoot = path.join(__dirname, 'backups')) {
  if (!['apply', 'restore'].includes(action)) return patchExtensionUnlocked(directory, action, backupRoot);
  const root = fs.realpathSync(directory);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(backupRoot, `.patch-${hash(Buffer.from(root)).slice(0, 16)}.lock`);
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`其他窗口正在处理 Codex 补丁；若进程已异常退出，请在关闭所有 VS Code 窗口后移除锁文件：${lock}`), { code: 'CODEX_MULTI_TAB_PATCH_BUSY' });
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, directory: root }));
    return patchExtensionUnlocked(root, action, backupRoot);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

if (require.main === module) {
  try {
    const [action, directory, backupRoot, ...extra] = process.argv.slice(2);
    if (!directory || extra.length) throw new Error('用法：node title-patch.js <dry-run|apply|restore> <官方扩展目录> [备份目录]');
    process.stdout.write(`${JSON.stringify(patchExtension(directory, action, backupRoot), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { patchExtension, transformHost, transformWebview, updatePanelTitle, observeTitle, waitForOnboardingState };
