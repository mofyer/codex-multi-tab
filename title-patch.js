'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');


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

function patchExtension(directory, action = 'dry-run', backupRoot = path.join(__dirname, 'backups')) {
  if (!['dry-run', 'apply', 'restore'].includes(action)) throw new Error('操作必须为 dry-run、apply 或 restore');
  const root = fs.realpathSync(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const profile = PROFILES[pkg.version];
  if (pkg.publisher !== 'openai' || pkg.name !== 'chatgpt' || !profile) throw new Error('不支持此官方扩展或版本，拒绝修改');
  const backup = path.join(backupRoot, `${pkg.version}-${hash(Buffer.from(root)).slice(0, 16)}`);
  const manifestFile = path.join(backup, 'manifest.json');
  const expectedFiles = ['out/extension.js', profile.asset];
  if (fs.existsSync(backup)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.root !== root || manifest.version !== pkg.version || manifest.format !== 1 || manifest.files.length !== 2) throw new Error('备份清单不匹配，拒绝修改');
    const entries = manifest.files.map((entry, index) => {
      if (entry.file !== expectedFiles[index] || entry.backup !== `${index}.original`) throw new Error('备份路径不匹配，拒绝修改');
      const original = fs.readFileSync(path.join(backup, entry.backup));
      if (hash(original) !== entry.originalHash) throw new Error('备份内容校验失败');
      const file = path.join(root, entry.file);
      const currentHash = hash(fs.readFileSync(file));
      if (currentHash !== entry.patchedHash && currentHash !== entry.originalHash) throw new Error(`文件已变化，拒绝覆盖：${entry.file}`);
      return { ...entry, original, file, currentHash };
    });
    if (action === 'restore') {
      for (const entry of entries) {
        if (entry.currentHash !== entry.originalHash) replaceFile(entry.file, entry.original, entry.currentHash);
      }
      fs.rmSync(backup, { recursive: true });
      return { status: 'restored', version: pkg.version, files: expectedFiles };
    }
    if (entries.some((entry, index) => entry.patchedHash !== hash(Buffer.from(index === 0
      ? transformHost(entry.original.toString('utf8')) : transformWebview(entry.original.toString('utf8'), profile.api))))) {
      throw new Error('发现旧版本补丁，请先 restore 再 apply');
    }
    if (!entries.every(entry => entry.currentHash === entry.patchedHash)) throw new Error('发现未完成的补丁，请先 restore 再 apply');
    return { status: 'already-applied', version: pkg.version, files: expectedFiles };
  }
  if (action === 'restore') return { status: 'not-applied', version: pkg.version };
  const entries = expectedFiles.map((relative, index) => {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file);
    const originalHash = hash(original);
    if (originalHash !== (index === 0 ? HOST_HASH : profile.webHash)) throw new Error(`官方文件哈希不匹配，拒绝修改：${relative}`);
    const source = original.toString('utf8');
    const patched = Buffer.from(index === 0 ? transformHost(source) : transformWebview(source, profile.api));
    return { file: relative, backup: `${index}.original`, originalHash, patchedHash: hash(patched), original, patched };
  });
  if (action === 'dry-run') return { status: 'ready', version: pkg.version, files: expectedFiles };
  fs.mkdirSync(backupRoot, { mode: 0o700, recursive: true });
  const staging = fs.mkdtempSync(path.join(backupRoot, '.title-backup-'));
  try {
    for (const entry of entries) fs.writeFileSync(path.join(staging, entry.backup), entry.original, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ format: 1, root, version: pkg.version, files: entries.map(({ original, patched, ...entry }) => entry) }, null, 2), { flag: 'wx', mode: 0o600 });
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

if (require.main === module) {
  try {
    const [action, directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length) throw new Error('用法：node title-patch.js <dry-run|apply|restore> <官方扩展目录>');
    process.stdout.write(`${JSON.stringify(patchExtension(directory, action), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { patchExtension, transformHost, transformWebview, updatePanelTitle, observeTitle, waitForOnboardingState };
