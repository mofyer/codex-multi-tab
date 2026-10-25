'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PATCH_VERSION = require('../../package.json').version;
const { getNativePatchFiles, getNativeDependencies } = require('./native-history-patch');
const { transformSidebarHost, transformSidebarWebview } = require('./sidebar-bridge-patch');
const LEGACY_HOST_ANCHOR = 'case"navigate-in-new-editor-tab":{let n=pI(r.path);';
const LEGACY_HOST_HASH = '820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f';
const PROFILES = {
  '26.5908.31748': {
    hostAnchor: LEGACY_HOST_ANCHOR,
    hostHash: LEGACY_HOST_HASH,
    asset: 'webview/assets/app-initial-972655adec02.js',
    api: 'qf',
    nuxAnchor: 'function lQn(){let{data:e,isLoading:t}=$g(xr.NUX_2025_09_15),{authMethod:n}=fu();',
    webHash: '919609dae54b1918456a1039eef6146dee869ec86061b7e845bc919e6fdbb5d5',
  },
  '26.908.40401': {
    hostAnchor: LEGACY_HOST_ANCHOR,
    hostHash: LEGACY_HOST_HASH,
    asset: 'webview/assets/app-initial-a190b16fc630.js',
    api: 'Jf',
    nuxAnchor: 'function pQn(){let{data:e,isLoading:t}=n_(xr.NUX_2025_09_15),{authMethod:n}=pu();',
    webHash: '50b1a443400ba2f7ac0be53c56536a3e145bccfff0e2f456f100850133a01683',
  },
  '26.917.61114': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=hM(r.path);',
    hostHash: '2ac22107521c9e8fd1c907bc335bd3b0609c8d612bb2731e8bed6badda5d6f13',
    asset: 'webview/assets/app-initial-801a1845d914.js',
    api: 'hp',
    nuxAnchor: 'function pcr(){let{data:e,isLoading:t}=iS(Cs.NUX_2025_09_15),{authMethod:n}=Zl();',
    webHash: 'd9cbca4f44d7206d83bcd136f12400282e51cbae2cc8a147cb8b2412faa71eb4',
  },
  // Codex 26.917.62051 changed the bundled asset names and host minification.
  // The host bridge and title/onboarding hooks were audited against the exact
  // hashes below; native history remains intentionally disabled for this build.
  '26.917.62051': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=fM(r.path);',
    hostHash: '7ba6208c447c393e050a8ba46893e9e1aa4abd718cb4a8610fa87b12942633bc',
    asset: 'webview/assets/app-initial-de4359f78ed1.js',
    api: 'hp',
    nuxAnchor: 'function pcr(){let{data:e,isLoading:t}=iS(Cs.NUX_2025_09_15),{authMethod:n}=Zl();',
    webHash: 'ffdf480c63b5c99009ae0b618cad846ac5f33af42af4cec900f633586370a9dc',
    coreOnly: true,
  },
  // 26.1002 起 webview 拆为多个 app-initial 分块；只修改持有 acquireVsCodeApi、
  // 首次引导和 useLocation 导入的入口分块。原生历史分块尚未审计，保持降级。
  '26.1002.51308': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=QN(r.path);',
    hostHash: 'bc0b44429768ea49c559c6a5524dcd710c500d6193f3bfe62c81cab75c18661c',
    asset: 'webview/assets/app-initial-d277996860bb.js',
    api: 'qp',
    nuxAnchor: 'function CBi(){let{data:e,isLoading:t}=DC(au.NUX_2025_09_15),{authMethod:n}=jd();',
    webHash: '1c843016a1334d3848e3ae4931ca2e9dbb649918d7ca7f8ea90ef09775aaf7c1',
    coreOnly: true,
  },
  '26.1007.21434': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=rF(r.path);',
    hostHash: 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8',
    asset: 'webview/assets/app-initial-c014f9ee4429.js',
    api: 'mm',
    nuxAnchor: 'function FGi(){let{data:e,isLoading:t}=UC(hs.NUX_2025_09_15),{authMethod:n}=Lf();',
    webHash: 'aabbfa7c366706365a239b090ca1c657b6a0213d7287e54ef0a32d1b2e5ff6a0',
  },
  // 此两版原生历史及分块依赖已单独审计，哈希不匹配时仍只启用核心桥。
  '26.51007.21434': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=rF(r.path);',
    hostHash: 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8',
    asset: 'webview/assets/app-initial-41ab338a184f.js',
    api: 'mm',
    nuxAnchor: 'function FGi(){let{data:e,isLoading:t}=UC(hs.NUX_2025_09_15),{authMethod:n}=Lf();',
    webHash: 'c755dbca916c0f830a554fe2e3057f8642b32394bea7701338e5d506f692ad56',
  },
  // 26.1021 起 acquireVsCodeApi、首次引导和 useLocation 调用方拆到独立分块；
  // 入口分块只用于识别版本，各分块按精确哈希分别打补丁。原生历史另按 native-history-patch 审计。
  '26.1021.22027': {
    hostAnchor: 'case"navigate-in-new-editor-tab":{let n=F1(r.path);',
    hostHash: 'a9cc6736cd2c2d22f6cf43fc5763d5f8a873e4f741f522b44a600b1926f4e627',
    asset: 'webview/assets/app-initial-13f932cb2f13.js',
    webHash: '9852ece5b9a25906b654fa8cccd77873105fe1b88556b141fc35dc4062511629',
    api: 'c',
    nuxAnchor: 'function v(){let{data:e,isLoading:t}=a(g),{authMethod:n}=f();if(l?.ideOnboarding==null)return`none`;',
    split: {
      api: ['webview/assets/message-bus-4113ba7287d7.js', '9536ce9674179537acc6ecb09a74a01af08b203f4eb812851ea05182311c3ff0'],
      onboarding: ['webview/assets/use-nux-cbb39779849d.js', '549c38283399a71024a529f534738d759d42a37c7c304874b63d2596ad31baff'],
      location: ['webview/assets/app-runtime-ca74aa759873.js', 'd2564b2aa1f07c7a0f9d2179544823020dcf3b26c7e66adcc0734293d3100f68'],
    },
  },
};

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

function transformHost(source, version = '26.908.40401') {
  const anchor = PROFILES[version]?.hostAnchor;
  if (!anchor) throw new Error('未知宿主补丁配置，拒绝修改');
  return replaceOnce(source, anchor,
    `case"codex-multi-tab-title":{(${updatePanelTitle.toString()})(this,e,r.title);break;}${anchor}`);
}

function transformTitleApi(source, api) {
  const anchor = `${api}=acquireVsCodeApi()`;
  return replaceOnce(source, anchor, `${anchor};(${observeTitle.toString()})(${api})`);
}

function transformOnboarding(source, nuxAnchor) {
  const nuxReplacement = nuxAnchor.replace('isLoading:t}', 'isLoading:t,status:codexNuxStatus,error:codexNuxError}')
    + `if((${waitForOnboardingState.toString()})(codexNuxStatus,codexNuxError))return;`;
  return replaceOnce(source, nuxAnchor, nuxReplacement);
}

function transformWebview(source, api) {
  const profile = Object.values(PROFILES).find(item => item.api === api && !item.split);
  if (!profile) throw new Error('未知 webview 补丁配置，拒绝修改');
  return transformOnboarding(transformTitleApi(source, api), profile.nuxAnchor);
}

// 拆分版本依次修改 API、首次引导和路由分块；数组顺序即备份清单顺序。
function getCorePatches(version) {
  const profile = PROFILES[version];
  const host = { file: 'out/extension.js', originalHash: profile.hostHash,
    transform: source => transformSidebarHost(transformHost(source, version), version) };
  if (!profile.split) {
    return [host, { file: profile.asset, originalHash: profile.webHash,
      transform: source => transformSidebarWebview(transformWebview(source, profile.api), version) }];
  }
  const { api, onboarding, location } = profile.split;
  return [host,
    { file: api[0], originalHash: api[1], transform: source => transformTitleApi(source, profile.api) },
    { file: onboarding[0], originalHash: onboarding[1], transform: source => transformOnboarding(source, profile.nuxAnchor) },
    { file: location[0], originalHash: location[1], transform: source => transformSidebarWebview(source, version) }];
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// 发行版本号可变化；仅当实际加载的已审计资产字节完全一致时复用兼容配置。
function resolveProfileVersion(root, version, manifest, checkDependencies, includeNative = true) {
  if (PROFILES[version]) return version;
  const htmlFile = path.join(root, 'webview/index.html');
  const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
  const matches = Object.entries(PROFILES).filter(([candidate, profile]) => {
    if (!html.includes(`"./${profile.asset.slice('webview/'.length)}"`)) return false;
    const files = [
      { file: 'out/extension.js', originalHash: profile.hostHash },
      { file: profile.asset, originalHash: profile.webHash },
      ...Object.values(profile.split ?? {}).map(([file, originalHash]) => ({ file, originalHash })),
      ...(includeNative ? getNativePatchFiles(candidate) : []),
      ...(checkDependencies && includeNative ? getNativeDependencies(candidate) : []),
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
  let profileVersion;
  try {
    profileVersion = resolveProfileVersion(root, pkg.version, savedManifest, action !== 'restore', savedManifest?.mode !== 'core-only');
  } catch (error) {
    // 新版官方扩展可能只改动原生历史资产；先按核心桥资产识别已审计配置，
    // 让独立标签和侧栏数据桥继续工作，同时保持未知核心资产拒绝修改。
    if (action === 'restore' || savedManifest) throw error;
    profileVersion = resolveProfileVersion(root, pkg.version, savedManifest, action !== 'restore', false);
  }
  const profile = PROFILES[profileVersion];
  const corePatches = getCorePatches(profileVersion);
  const nativePatches = getNativePatchFiles(profileVersion);
  const nativeCompatible = action === 'restore' || (nativePatches.length > 0 && nativePatches.every(patch => {
    const file = path.join(root, patch.file);
    if (!fs.existsSync(file)) return false;
    const currentHash = hash(fs.readFileSync(file));
    if (currentHash === patch.originalHash) return true;
    const saved = Array.isArray(savedManifest?.files) ? savedManifest.files.find(entry => entry.file === patch.file) : undefined;
    // 这里只识别旧补丁；下方 entries 会独立校验每一份备份和当前文件。
    return saved?.originalHash === patch.originalHash && saved.patchedHash === currentHash;
  }) && getNativeDependencies(profileVersion).every(dependency => {
    const file = path.join(root, dependency.file);
    return fs.existsSync(file) && hash(fs.readFileSync(file)) === dependency.originalHash;
  }));
  const degraded = profile.coreOnly === true || (savedManifest?.mode === 'core-only' && (action === 'restore' || !nativeCompatible))
    || (!savedManifest && action !== 'restore' && !nativeCompatible);
  const patches = [...corePatches];
  if (degraded && savedManifest && savedManifest.mode !== 'core-only') {
    throw new Error('新增补丁资产不兼容，保留已有增强');
  }
  for (const native of (degraded ? [] : nativePatches)) {
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
    // 旧版或 core-only 只修改核心文件，保留其恢复路径以便安全升级组合补丁。
    if (!manifest || manifest.root !== root || manifest.version !== pkg.version || manifest.format !== 1 || !Array.isArray(manifest.files)
      || ![2, corePatches.length, expectedFiles.length].includes(manifest.files.length)) throw new Error('备份清单不匹配，拒绝修改');
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
    if (!degraded && !nativeCompatible) throw new Error('原生历史依赖资产不兼容，保留已有增强');
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
    return { status: 'already-applied', version: pkg.version, files: expectedFiles,
      degraded: manifest.mode === 'core-only' || profile.coreOnly === true };
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
  if (action === 'dry-run') return { status: 'ready', version: pkg.version, files: expectedFiles, degraded };
  fs.mkdirSync(backupRoot, { mode: 0o700, recursive: true });
  const staging = fs.mkdtempSync(path.join(backupRoot, '.title-backup-'));
  try {
    for (const entry of entries) fs.writeFileSync(path.join(staging, entry.backup), entry.original, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ format: 1, root, version: pkg.version, patchVersion: PATCH_VERSION, ...(degraded ? { mode: 'core-only' } : {}), files: entries.map(({ original, patched, ...entry }) => entry) }, null, 2), { flag: 'wx', mode: 0o600 });
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
  return { status: 'applied', version: pkg.version, files: expectedFiles, degraded };
}

// 不同 VS Code 窗口共享同一备份根目录；写入期间禁止另一个进程恢复或应用。
function patchExtension(directory, action = 'dry-run', backupRoot = path.join(__dirname, '../../backups')) {
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

function runCli() {
  try {
    const [action, directory, backupRoot, ...extra] = process.argv.slice(2);
    if (!directory || extra.length) throw new Error('用法：node title-patch.js <dry-run|apply|restore> <官方扩展目录> [备份目录]');
    process.stdout.write(`${JSON.stringify(patchExtension(directory, action, backupRoot), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = { runCli, patchExtension, getCorePatches, transformHost, transformWebview, transformTitleApi, transformOnboarding,
  updatePanelTitle, observeTitle, waitForOnboardingState };
