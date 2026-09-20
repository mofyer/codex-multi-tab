'use strict';

const nativeFs = require('node:fs/promises');
const nativeSyncFs = require('node:fs');
const { constants } = nativeSyncFs;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES = 100;
const MAX_LOCK_BYTES = 1024;
const LOCK_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const messages = {
  UNSUPPORTED: '当前认证环境暂不支持账号切换，请使用本地文件存储的 ChatGPT 登录。',
  INVALID_AUTH: '登录凭据格式无法安全识别，请先在官方 Codex 中重新登录。',
  IDENTITY: '当前登录身份已变化或无法核对，请刷新账号后重试。',
  BUSY: '另一个窗口正在管理账号，请稍后重试。',
  CHANGED: '登录文件已被其他操作更新，本次未覆盖，请刷新后重试。',
  NOT_FOUND: '已保存的账号不存在，请刷新账号列表。',
  INVALID_LABEL: '账号备注需为 1 至 80 个字符。',
  STORAGE: '无法安全读取或保存账号，请检查本地文件和系统凭据存储后重试。',
};

class AccountStoreError extends Error {
  constructor(code) { super(messages[code]); this.code = `CODEX_MULTI_TAB_ACCOUNT_${code}`; }
}
const fail = code => new AccountStoreError(code);
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sameBytes = (left, right) => left === null ? right === null : right !== null && left.equals(right);

/** Decode only for identity comparison; the official client remains responsible for token validation. */
function parseAuth(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw fail('INVALID_AUTH');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!plain(value) || Object.keys(value).some(key => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))
      || (value.auth_mode !== undefined && value.auth_mode !== 'chatgpt')
      || (value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null)
      || !plain(value.tokens)) throw fail('INVALID_AUTH');
    const tokens = value.tokens;
    if (Object.keys(tokens).some(key => !['id_token', 'access_token', 'refresh_token', 'account_id'].includes(key))
      || !['id_token', 'access_token', 'refresh_token', 'account_id'].every(key => nonempty(tokens[key]))
      || tokens.account_id.length > 512) throw fail('INVALID_AUTH');
    const parts = tokens.id_token.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw fail('INVALID_AUTH');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = claims?.['https://api.openai.com/auth'];
    if (!plain(claims) || !nonempty(claims.email) || claims.email.length > 320
      || !plain(auth) || auth.chatgpt_account_id !== tokens.account_id) throw fail('INVALID_AUTH');
    const email = claims.email.trim();
    return {
      id: hash(JSON.stringify([tokens.account_id, email.toLowerCase()])),
      accountId: tokens.account_id, email,
      planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type.slice(0, 80) : '',
    };
  } catch (error) { throw error instanceof AccountStoreError ? error : fail('INVALID_AUTH'); }
}

/** Conservative root-key parsing: complex authentication expressions are never guessed. */
function parseAuthConfig(bytes) {
  const result = { store: 'file', workspaceId: null };
  if (bytes === null) return result;
  const seen = new Set();
  for (const raw of bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    // Multiline strings or arrays at the root cannot be safely skipped by this small parser.
    if (line.includes('"""') || line.includes("'''")) throw fail('UNSUPPORTED');
    const assignment = /^(?:([A-Za-z0-9_-]+)|"([^"\\]+)"|'([^']+)')\s*=\s*(.*)$/.exec(line);
    if (!assignment) throw fail('UNSUPPORTED');
    const key = assignment[1] || assignment[2] || assignment[3];
    const expression = assignment[4];
    if (!['cli_auth_credentials_store', 'forced_login_method', 'forced_chatgpt_workspace_id'].includes(key)) {
      // An opening array/object continuing on later lines could hide a key or a table marker.
      if (/^[\[{]/.test(expression) && !/[\]}]\s*(?:#.*)?$/.test(expression)) throw fail('UNSUPPORTED');
      continue;
    }
    if (seen.has(key)) throw fail('UNSUPPORTED');
    seen.add(key);
    const value = /^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(expression);
    if (!value) throw fail('UNSUPPORTED');
    const text = value[1] ?? value[2];
    if (key === 'cli_auth_credentials_store' && text !== 'file') throw fail('UNSUPPORTED');
    if (key === 'forced_login_method' && text !== 'chatgpt') throw fail('UNSUPPORTED');
    if (key === 'forced_chatgpt_workspace_id') {
      if (!text.trim() || text.length > 512) throw fail('UNSUPPORTED');
      result.workspaceId = text;
    }
  }
  return result;
}

function createAccountStore(context, { home, fs = nativeFs, syncFs = nativeSyncFs, readEnvironment } = {}) {
  const validHome = typeof home === 'string' && path.isAbsolute(home) && !home.includes('\0');
  const directory = validHome ? path.resolve(home) : '';
  const authPath = path.join(directory, 'auth.json');
  const lockPath = path.join(directory, '.codex-multi-tab-account.lock');
  const vaultKey = `codexMultiTab.accounts.v1.${hash(directory)}`;
  const safe = operation => async (...args) => {
    try { return await operation(...args); }
    catch (error) { throw error instanceof AccountStoreError ? error : fail('STORAGE'); }
  };

  async function ensureHome() {
    if (!validHome || !context?.secrets?.get || !context?.secrets?.store) throw fail('UNSUPPORTED');
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSUPPORTED');
  }

  async function readBounded(file, optional = true, maximum = MAX_FILE_BYTES) {
    let handle;
    try {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw fail('UNSUPPORTED');
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) throw fail('CHANGED');
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length > maximum) throw fail('UNSUPPORTED');
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== after.size) throw fail('CHANGED');
      return buffer.subarray(0, length);
    } catch (error) {
      if (!handle && optional && error.code === 'ENOENT') return null;
      throw error;
    } finally { if (handle) await handle.close(); }
  }

  async function environment() {
    await ensureHome();
    if (readEnvironment !== undefined) {
      if (typeof readEnvironment !== 'function') throw fail('UNSUPPORTED');
      const effective = await readEnvironment();
      if (!plain(effective) || effective.supported !== true || effective.authStorage !== 'file'
        || typeof effective.home !== 'string' || !path.isAbsolute(effective.home) || effective.home.includes('\0')
        || path.resolve(effective.home) !== directory || !Array.isArray(effective.forcedWorkspaceIds)
        || !effective.forcedWorkspaceIds.every(id => nonempty(id) && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id))) {
        throw fail('UNSUPPORTED');
      }
      return { store: 'file', workspaceIds: [...effective.forcedWorkspaceIds] };
    }
    const config = parseAuthConfig(await readBounded(path.join(directory, 'config.toml')));
    return { store: config.store, workspaceIds: config.workspaceId ? [config.workspaceId] : [] };
  }

  function sameLockDirectory(lock) {
    const current = syncFs.lstatSync(lockPath);
    return current.isDirectory() && !current.isSymbolicLink()
      && current.ino === lock.ino && current.dev === lock.dev;
  }

  function readLock() {
    let fd;
    try {
      const directoryStat = syncFs.lstatSync(lockPath);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw fail('BUSY');
      const entries = syncFs.readdirSync(lockPath);
      if (entries.length !== 1) throw fail('BUSY');
      const file = path.join(lockPath, entries[0]);
      const before = syncFs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) throw fail('BUSY');
      fd = syncFs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = syncFs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_LOCK_BYTES) throw fail('BUSY');
      const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = syncFs.readSync(fd, bytes, length, bytes.length - length, length);
        if (!read) break;
        length += read;
      }
      const after = syncFs.fstatSync(fd);
      if (length > MAX_LOCK_BYTES || length !== after.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw fail('BUSY');
      const owner = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!plain(owner) || Object.keys(owner).sort().join(',') !== 'pid,token'
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647
        || typeof owner.token !== 'string' || !LOCK_TOKEN.test(owner.token)
        || entries[0] !== `owner-${owner.token}.json`) throw fail('BUSY');
      const lock = { ...owner, ino: directoryStat.ino, dev: directoryStat.dev };
      if (!sameLockDirectory(lock)) throw fail('BUSY');
      return lock;
    } catch { throw fail('BUSY'); }
    finally { if (fd !== undefined) syncFs.closeSync(fd); }
  }

  function verifyLock(lock) {
    const current = readLock();
    if (current.ino !== lock.ino || current.dev !== lock.dev
      || current.token !== lock.token || current.pid !== lock.pid) throw fail('BUSY');
  }

  function writeLockOwner(lock) {
    if (!sameLockDirectory(lock)) throw fail('BUSY');
    syncFs.writeFileSync(path.join(lockPath, `owner-${lock.token}.json`),
      JSON.stringify({ pid: lock.pid, token: lock.token }), { flag: 'wx', mode: 0o600 });
  }

  function releaseLock(lock) {
    verifyLock(lock);
    // Only the remover of this unique owner file may remove the directory. A second
    // reaper cannot remove a new owner's file even if the lock path has been reused.
    syncFs.unlinkSync(path.join(lockPath, `owner-${lock.token}.json`));
    try {
      if (!sameLockDirectory(lock)) throw fail('BUSY');
      syncFs.rmdirSync(lockPath);
    } catch (error) {
      // Keep rollback usable when directory removal fails. Never replace another owner.
      try { writeLockOwner(lock); } catch { /* Fail closed if ownership changed. */ }
      throw error;
    }
  }

  function createLock() {
    syncFs.mkdirSync(lockPath, { mode: 0o700 });
    const created = syncFs.lstatSync(lockPath);
    const lock = { ino: created.ino, dev: created.dev, pid: process.pid, token: randomUUID(), claimed: true, retained: false };
    try { writeLockOwner(lock); }
    catch (error) {
      // Only remove our unchanged empty directory; partial or unknown owner data stays closed.
      try { if (sameLockDirectory(lock) && syncFs.readdirSync(lockPath).length === 0) syncFs.rmdirSync(lockPath); } catch { /* Preserve uncertain ownership. */ }
      throw error;
    }
    return lock;
  }

  function acquireLock() {
    // No await between mkdir and owner creation, or owner removal and rmdir:
    // a normal extension-host shutdown callback cannot leave an empty lock between them.
    // SIGKILL or a machine crash can still interrupt a syscall; unknown locks stay closed.
    try { return createLock(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readLock();
      try { process.kill(previous.pid, 0); throw fail('BUSY'); }
      catch (probeError) { if (probeError.code !== 'ESRCH') throw fail('BUSY'); }
      try {
        releaseLock(previous);
        return createLock();
      } catch { throw fail('BUSY'); }
    }
  }

  async function withLock(operation, retainedLock) {
    await ensureHome();
    let lock;
    if (retainedLock?.retained) {
      if (retainedLock.claimed) throw fail('BUSY');
      retainedLock.claimed = true;
      try {
        await verifyLock(retainedLock);
      } catch (error) { retainedLock.claimed = false; throw error; }
      lock = retainedLock;
    } else {
      lock = await acquireLock();
    }
    let result;
    try { result = await operation(lock); return result; }
    finally {
      try { await releaseLock(lock); lock.retained = false; }
      catch {
        // The operation may already be committed. Keep its result and rollback handle usable.
        // Only that handle can reuse this exact retained lock; other callers remain blocked.
        lock.retained = true;
        if (result && typeof result === 'object') {
          result.cleanupWarning = '账号操作已完成，但本地操作锁未能释放，后续账号操作暂不可用。';
        }
      }
      lock.claimed = false;
    }
  }

  async function readVault() {
    const raw = await context.secrets.get(vaultKey);
    if (raw === undefined || raw === null) return { version: 1, profiles: [] };
    if (typeof raw !== 'string' || raw.length > MAX_FILE_BYTES * MAX_PROFILES) throw fail('STORAGE');
    let vault;
    try { vault = JSON.parse(raw); } catch { throw fail('STORAGE'); }
    if (!plain(vault) || vault.version !== 1 || !Array.isArray(vault.profiles) || vault.profiles.length > MAX_PROFILES) throw fail('STORAGE');
    const seen = new Set();
    for (const profile of vault.profiles) {
      if (!plain(profile) || typeof profile.auth !== 'string') throw fail('STORAGE');
      const metadata = parseAuth(Buffer.from(profile.auth, 'utf8'));
      if (profile.id !== metadata.id || seen.has(profile.id)
        || typeof profile.label !== 'string' || profile.label.length > 80) throw fail('STORAGE');
      seen.add(profile.id);
    }
    return vault;
  }

  const metadata = profile => ({ ...parseAuth(Buffer.from(profile.auth, 'utf8')), label: profile.label });
  const writeVault = vault => context.secrets.store(vaultKey, JSON.stringify(vault));
  const requireProfile = (vault, id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('NOT_FOUND');
    const profile = vault.profiles.find(value => value.id === id);
    if (!profile) throw fail('NOT_FOUND');
    return profile;
  };

  function validateCurrent(bytes, expected, config) {
    if (bytes === null) {
      if (expected !== null) throw fail('IDENTITY');
      return null;
    }
    const current = parseAuth(bytes);
    if (!plain(expected) || (expected.type !== undefined && expected.type !== 'chatgpt')
      || !nonempty(expected.email) || expected.email.trim().toLowerCase() !== current.email.toLowerCase()
      || (expected.accountId != null && expected.accountId !== current.accountId)) throw fail('IDENTITY');
    if (config.workspaceIds.length && !config.workspaceIds.includes(current.accountId)) throw fail('UNSUPPORTED');
    return current;
  }

  function upsert(vault, bytes, current) {
    const existing = vault.profiles.find(profile => profile.id === current.id);
    if (existing) existing.auth = bytes.toString('utf8');
    else {
      if (vault.profiles.length >= MAX_PROFILES) throw fail('STORAGE');
      vault.profiles.push({ id: current.id, label: '', auth: bytes.toString('utf8') });
    }
    return metadata(vault.profiles.find(profile => profile.id === current.id));
  }

  async function compareAndWrite(expected, replacement) {
    await ensureHome();
    if (!sameBytes(expected, await readBounded(authPath))) throw fail('CHANGED');
    if (replacement === null) { await fs.unlink(authPath); return; }
    const temporary = path.join(directory, `.codex-multi-tab-auth-${randomUUID()}.tmp`);
    let handle;
    let committed = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(replacement);
      await handle.sync();
      await handle.close(); handle = undefined;
      // Best-effort detection of external refreshes; read + rename is not a filesystem CAS.
      await ensureHome();
      if (!sameBytes(expected, await readBounded(authPath))) throw fail('CHANGED');
      await fs.rename(temporary, authPath);
      committed = true;
    } finally {
      if (handle) await handle.close();
      if (!committed) {
        try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  return {
    checkSupport: safe(async () => { await environment(); return { supported: true }; }),
    // SecretStorage returns one complete string; readers need no filesystem write lock.
    list: safe(async () => { await environment(); return (await readVault()).profiles.map(metadata); }),
    saveCurrent: safe(expected => withLock(async () => {
      const config = await environment();
      const bytes = await readBounded(authPath);
      const current = validateCurrent(bytes, expected, config);
      if (!current) throw fail('IDENTITY');
      const vault = await readVault();
      const profile = upsert(vault, bytes, current);
      if (!sameBytes(bytes, await readBounded(authPath))) throw fail('CHANGED');
      await writeVault(vault);
      return profile;
    })),
    rename: safe((id, label) => withLock(async () => {
      await environment();
      if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw fail('INVALID_LABEL');
      const vault = await readVault();
      const profile = requireProfile(vault, id);
      profile.label = label.trim();
      await writeVault(vault);
      return metadata(profile);
    })),
    remove: safe(id => withLock(async () => {
      await environment();
      const vault = await readVault();
      requireProfile(vault, id);
      vault.profiles = vault.profiles.filter(profile => profile.id !== id);
      await writeVault(vault);
    })),
    stageSwitch: safe((id, expected, beforeWrite) => withLock(async lock => {
      if (beforeWrite !== undefined && typeof beforeWrite !== 'function') throw fail('UNSUPPORTED');
      const config = await environment();
      const vault = await readVault();
      const target = requireProfile(vault, id);
      const targetMeta = metadata(target);
      if (config.workspaceIds.length && !config.workspaceIds.includes(targetMeta.accountId)) throw fail('UNSUPPORTED');
      const original = await readBounded(authPath);
      const current = validateCurrent(original, expected, config);
      if (current?.id === id) {
        upsert(vault, original, current);
        await writeVault(vault);
        return { changed: false, id, rollback: async () => false };
      }
      if (current) { upsert(vault, original, current); await writeVault(vault); }
      const replacement = Buffer.from(target.auth, 'utf8');
      if (beforeWrite) await beforeWrite();
      const latestConfig = await environment();
      validateCurrent(original, expected, latestConfig);
      if (latestConfig.workspaceIds.length && !latestConfig.workspaceIds.includes(targetMeta.accountId)) throw fail('UNSUPPORTED');
      await compareAndWrite(original, replacement);
      let rolledBack = false;
      return { changed: true, id, rollback: safe(() => withLock(async () => {
        if (rolledBack) return false;
        if (!sameBytes(replacement, await readBounded(authPath))) return false;
        await compareAndWrite(replacement, original);
        rolledBack = true;
        return true;
      }, lock)) };
    })),
  };
}

module.exports = { createAccountStore, parseAuth, parseAuthConfig };
