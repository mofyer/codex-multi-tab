'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createAccountStore, parseAuth, parseAuthConfig } = require('../src/accounts/account-store');

// Entirely synthetic credentials. No test reads or modifies a user's Codex directory.
function auth(email = 'one@example.test', accountId = 'workspace-one', suffix = 'initial') {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' } };
  return Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`,
      access_token: `synthetic-access-${suffix}`, refresh_token: `synthetic-refresh-${suffix}`, account_id: accountId },
    last_refresh: '2026-09-17T00:00:00Z' }));
}

async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-multi-tab-accounts-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const values = new Map();
  const context = { secrets: { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } } };
  const store = createAccountStore(context, { home, ...options });
  const file = path.join(home, 'auth.json');
  const put = bytes => fs.writeFile(file, bytes);
  return { home, file, store, context, values, put };
}
const expected = (email = 'one@example.test', accountId = 'workspace-one') => ({ type: 'chatgpt', email, accountId });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === `CODEX_MULTI_TAB_ACCOUNT_${code}`);

test('保存到单一 SecretStorage vault，仅返回安全元数据并保留备注和最新 token', async t => {
  const app = await setup(t);
  await app.put(auth());
  const profile = await app.store.saveCurrent(expected());
  assert.deepEqual(Object.keys(profile).sort(), ['accountId', 'email', 'id', 'label', 'planType']);
  assert.equal(profile.id.length, 64);
  assert.equal(profile.email, 'one@example.test');
  assert.equal(profile.planType, 'pro');
  assert.equal(app.values.size, 1);
  await app.store.rename(profile.id, '  工作账号  ');
  await app.put(auth(undefined, undefined, 'refreshed'));
  const latest = await app.store.saveCurrent(expected());
  assert.equal(latest.label, '工作账号');
  assert.deepEqual(await app.store.list(), [latest]);
  assert.ok(!JSON.stringify(latest).includes('synthetic'));
  assert.ok([...app.values.values()][0].includes('synthetic-refresh-refreshed'));
  await app.store.remove(profile.id);
  assert.deepEqual(await app.store.list(), []);
  assert.deepEqual(await fs.readFile(app.file), auth(undefined, undefined, 'refreshed'));
});

test('切换先保存当前更新的凭据，原子写入 0600 文件，并支持一次回滚', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const target = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  const original = auth(undefined, undefined, 'refreshed');
  await app.put(original);
  const result = await app.store.stageSwitch(target.id, expected());
  assert.equal(result.changed, true);
  assert.equal(result.id, target.id);
  assert.deepEqual(await fs.readFile(app.file), auth('two@example.test', 'workspace-two'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(app.file)).mode & 0o777, 0o600);
  assert.equal((await app.store.list()).length, 2);
  assert.ok([...app.values.values()][0].includes('synthetic-refresh-refreshed'));
  assert.equal(await result.rollback(), true);
  assert.equal(await result.rollback(), false);
  assert.deepEqual(await fs.readFile(app.file), original);
  assert.deepEqual((await fs.readdir(app.home)).filter(name => name.includes('.tmp') || name.includes('.lock')), []);
});

test('相同身份不会写回陈旧 token，更新已保存的凭据且无需重载', async t => {
  const app = await setup(t);
  await app.put(auth());
  const profile = await app.store.saveCurrent(expected());
  const refreshed = auth(undefined, undefined, 'latest');
  await app.put(refreshed);
  const result = await app.store.stageSwitch(profile.id, expected());
  assert.equal(result.changed, false);
  assert.deepEqual(await fs.readFile(app.file), refreshed);
  assert.ok([...app.values.values()][0].includes('synthetic-refresh-latest'));
});

test('回滚不得覆盖切换后其他操作刷新的 token', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  const result = await app.store.stageSwitch(profile.id, expected());
  const concurrent = auth('two@example.test', 'workspace-two', 'external-refresh');
  await app.put(concurrent);
  assert.equal(await result.rollback(), false);
  assert.deepEqual(await fs.readFile(app.file), concurrent);
});

test('未登录仅在 auth 文件不存在且 expected 为 null 时允许恢复，回滚恢复为不存在', async t => {
  const app = await setup(t);
  await app.put(auth());
  const profile = await app.store.saveCurrent(expected());
  await fs.unlink(app.file);
  await rejectsCode(app.store.stageSwitch(profile.id, expected()), 'IDENTITY');
  const result = await app.store.stageSwitch(profile.id, null);
  assert.equal(result.changed, true);
  assert.equal(await result.rollback(), true);
  await assert.rejects(fs.stat(app.file), { code: 'ENOENT' });
  await app.put(auth());
  await rejectsCode(app.store.stageSwitch(profile.id, null), 'IDENTITY');
});

test('同一邮箱不同 workspace 分开保存，身份不匹配时拒绝写入', async t => {
  const app = await setup(t);
  await app.put(auth());
  const one = await app.store.saveCurrent(expected());
  await app.put(auth(undefined, 'workspace-two'));
  await rejectsCode(app.store.saveCurrent(expected()), 'IDENTITY');
  await rejectsCode(app.store.saveCurrent(expected('someone@example.test', 'workspace-two')), 'IDENTITY');
  const two = await app.store.saveCurrent(expected('one@example.test', 'workspace-two'));
  assert.notEqual(one.id, two.id);
  assert.equal((await app.store.list()).length, 2);
});

test('文件锁在跨实例操作期间拒绝并发，不自动移除已有锁', async t => {
  const app = await setup(t);
  await app.put(auth());
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalStore = app.context.secrets.store;
  app.context.secrets.store = async (...args) => { entered(); await gate; return originalStore(...args); };
  const pending = app.store.saveCurrent(expected());
  await started;
  const other = createAccountStore(app.context, { home: app.home });
  await rejectsCode(other.saveCurrent(expected()), 'BUSY');
  assert.deepEqual(await other.list(), []);
  assert.ok((await fs.stat(path.join(app.home, '.codex-multi-tab-account.lock'))).isDirectory());
  release(); await pending;
  assert.equal((await other.list()).length, 1);
  await fs.mkdir(path.join(app.home, '.codex-multi-tab-account.lock'));
  assert.equal((await other.list()).length, 1);
  await rejectsCode(other.saveCurrent(expected()), 'BUSY');
  assert.ok((await fs.stat(path.join(app.home, '.codex-multi-tab-account.lock'))).isDirectory());
});

async function childHoldingLock(t, home) {
  const child = spawn(process.execPath, ['-e', `
    const { createAccountStore } = require(process.argv[1]);
    const store = createAccountStore({ secrets: {
      async get() {}, async store() { process.send('locked'); await new Promise(() => {}); }
    } }, { home: process.argv[2] });
    process.on('message', () => process.exit(0));
    store.saveCurrent({ type: 'chatgpt', email: 'one@example.test', accountId: 'workspace-one' })
      .catch(() => process.exit(1));
  `, require.resolve('../src/accounts/account-store'), home], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child lock acquisition timed out')), 5000);
    child.once('message', message => { clearTimeout(timer); assert.equal(message, 'locked'); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited before lock acquisition')); });
  });
  return { child, exited };
}

for (const termination of ['exit', 'kill']) {
  test(`真实子进程持有锁时拒绝写入，${termination} 后安全回收并恢复写入`, async t => {
    const app = await setup(t);
    await app.put(auth());
    const { child, exited } = await childHoldingLock(t, app.home);
    const lock = path.join(app.home, '.codex-multi-tab-account.lock');
    const entries = await fs.readdir(lock);
    const owner = JSON.parse(await fs.readFile(path.join(lock, entries[0]), 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['pid', 'token']);
    assert.equal(owner.pid, child.pid);
    assert.equal(entries[0], `owner-${owner.token}.json`);
    assert.deepEqual(await app.store.list(), []);
    await rejectsCode(app.store.saveCurrent(expected()), 'BUSY');
    if (termination === 'exit') child.send('exit'); else child.kill('SIGKILL');
    await exited;
    assert.equal((await app.store.saveCurrent(expected())).email, 'one@example.test');
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  });
}

for (const phase of ['mkdir', 'unlink']) {
  test(`正常宿主退出回调在 ${phase} 后到达时不会留下空锁`, { timeout: 5000 }, async t => {
    const app = await setup(t);
    await app.put(auth());
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs/promises'), syncFs = require('node:fs'), path = require('node:path');
      const { createAccountStore } = require(process.argv[1]);
      const home = process.argv[2], phase = process.argv[3];
      const stop = () => {
        syncFs.writeFileSync(path.join(home, 'termination-reached'), phase);
        setImmediate(() => process.exit(0));
      };
      const asyncIo = { ...fs, async [phase](...args) {
        await fs[phase](...args); stop();
        await new Promise(resolve => setImmediate(resolve));
      } };
      const syncIo = { ...syncFs, [phase + 'Sync'](...args) {
        const value = syncFs[phase + 'Sync'](...args); stop(); return value;
      } };
      const store = createAccountStore({ secrets: { async get() {}, async store() {} } }, { home, fs: asyncIo, syncFs: syncIo });
      store.saveCurrent({ type: 'chatgpt', email: 'one@example.test', accountId: 'workspace-one' })
        .catch(() => process.exit(2));
    `, require.resolve('../src/accounts/account-store'), app.home, phase], { stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(await fs.readFile(path.join(app.home, 'termination-reached'), 'utf8'), phase);
    const lock = path.join(app.home, '.codex-multi-tab-account.lock');
    if (phase === 'mkdir') {
      const entries = await fs.readdir(lock);
      assert.equal(entries.length, 1);
      const owner = JSON.parse(await fs.readFile(path.join(lock, entries[0]), 'utf8'));
      assert.equal(owner.pid, child.pid);
      assert.equal(entries[0], `owner-${owner.token}.json`);
    } else await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    await app.store.saveCurrent(expected());
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
  });
}

test('只读列表不创建锁，写入者并发时只有一个成功', async t => {
  const app = await setup(t, { syncFs: { ...syncFs, mkdirSync() { throw new Error('unexpected writer lock'); } } });
  assert.deepEqual(await app.store.list(), []);
  await app.put(auth());
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const originalStore = app.context.secrets.store;
  app.context.secrets.store = async (...args) => { entered(); await gate; return originalStore(...args); };
  const writers = Array.from({ length: 8 }, () => createAccountStore(app.context, { home: app.home }));
  const first = writers[0].saveCurrent(expected());
  await started;
  await Promise.all(writers.slice(1).map(store => rejectsCode(store.saveCurrent(expected()), 'BUSY')));
  assert.deepEqual(await app.store.list(), []);
  release(); await first;
  assert.equal((await app.store.list()).length, 1);
});

test('多个写入者竞争回收退出进程的锁时仅一方进入写入', async t => {
  const app = await setup(t);
  await app.put(auth());
  const { child, exited } = await childHoldingLock(t, app.home);
  child.kill('SIGKILL');
  await exited;
  let release;
  let entered;
  let failed = 0;
  let rejected;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const losers = new Promise(resolve => { rejected = resolve; });
  const originalStore = app.context.secrets.store;
  app.context.secrets.store = async (...args) => { entered(); await gate; return originalStore(...args); };
  const writers = Array.from({ length: 8 }, () => createAccountStore(app.context, { home: app.home }));
  const pending = writers.map(store => store.saveCurrent(expected()).catch(error => {
    assert.equal(error.code, 'CODEX_MULTI_TAB_ACCOUNT_BUSY');
    if (++failed === writers.length - 1) rejected();
    return null;
  }));
  await started;
  await losers;
  release();
  assert.equal((await Promise.all(pending)).filter(Boolean).length, 1);
  assert.equal((await app.store.list()).length, 1);
});

test('PID 探测返回 EPERM 时不回收锁', async t => {
  const app = await setup(t);
  await app.put(auth());
  const lock = path.join(app.home, '.codex-multi-tab-account.lock');
  const token = randomUUID();
  const file = path.join(lock, `owner-${token}.json`);
  await fs.mkdir(lock);
  const bytes = JSON.stringify({ pid: process.pid, token });
  await fs.writeFile(file, bytes);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('synthetic-private-error'), { code: 'EPERM' }); });
  await rejectsCode(app.store.saveCurrent(expected()), 'BUSY');
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('不回收空锁、错误类型、过大、无效或意外字段的 owner，错误不泄露文件内容', async t => {
  const app = await setup(t);
  await app.put(auth());
  const lock = path.join(app.home, '.codex-multi-tab-account.lock');
  const token = randomUUID();
  const file = path.join(lock, `owner-${token}.json`);
  for (const writeOwner of [
    async () => {},
    () => fs.writeFile(file, '{synthetic-secret'),
    () => fs.writeFile(file, 'synthetic-secret'.repeat(1000)),
    () => fs.mkdir(file),
    () => fs.symlink(app.file, file),
    () => fs.writeFile(file, JSON.stringify({ pid: -1, token })),
    () => fs.writeFile(file, JSON.stringify({ pid: process.pid, token: 'synthetic-secret' })),
    () => fs.writeFile(file, JSON.stringify({ pid: process.pid, token, unexpected: 'synthetic-secret' })),
    async () => { await fs.writeFile(file, JSON.stringify({ pid: process.pid, token })); await fs.writeFile(path.join(lock, 'extra'), ''); },
  ]) {
    await fs.mkdir(lock);
    await writeOwner();
    const before = await fs.readdir(lock);
    await assert.rejects(app.store.saveCurrent(expected()), error => {
      assert.equal(error.code, 'CODEX_MULTI_TAB_ACCOUNT_BUSY');
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
    assert.deepEqual(await fs.readdir(lock), before);
    assert.deepEqual(await app.store.list(), []);
    await fs.rm(lock, { recursive: true });
  }
});

test('操作期间锁目录被替换时释放不删除新锁', async t => {
  const app = await setup(t);
  await app.put(auth());
  const lock = path.join(app.home, '.codex-multi-tab-account.lock');
  const originalStore = app.context.secrets.store;
  app.context.secrets.store = async (...args) => {
    await fs.rename(lock, path.join(app.home, 'old-lock'));
    await fs.mkdir(lock);
    return originalStore(...args);
  };
  const result = await app.store.saveCurrent(expected());
  assert.match(result.cleanupWarning, /锁未能释放/);
  assert.ok((await fs.stat(lock)).isDirectory());
  assert.deepEqual(await fs.readdir(lock), []);
});

test('不同 home 使用独立 vault，不相互覆盖', async t => {
  const one = await setup(t), two = await setup(t);
  await one.put(auth()); await two.put(auth('two@example.test', 'workspace-two'));
  const other = createAccountStore(one.context, { home: two.home });
  await one.store.saveCurrent(expected());
  await other.saveCurrent(expected('two@example.test', 'workspace-two'));
  assert.equal(one.values.size, 2);
  assert.equal((await one.store.list())[0].email, 'one@example.test');
  assert.equal((await other.list())[0].email, 'two@example.test');
});

test('保存 vault 失败时不修改当前认证，原始异常文本不向调用方泄露', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  app.context.secrets.store = async () => { throw new Error('synthetic-refresh-LEAK'); };
  await assert.rejects(app.store.stageSwitch(profile.id, expected()), error => {
    assert.equal(error.code, 'CODEX_MULTI_TAB_ACCOUNT_STORAGE');
    assert.ok(!JSON.stringify(error).includes('LEAK'));
    assert.ok(!error.message.includes('LEAK'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(await fs.readFile(app.file), auth());
  assert.ok(!(await fs.readdir(app.home)).some(name => name.endsWith('.lock')));
});

test('原子重命名失败时原文件保留并清理临时凭据文件', async t => {
  const app = await setup(t, { fs: { ...fs, async rename() { throw new Error('synthetic-secret-path'); } } });
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  await rejectsCode(app.store.stageSwitch(profile.id, expected()), 'STORAGE');
  assert.deepEqual(await fs.readFile(app.file), auth());
  assert.deepEqual(await fs.readdir(app.home), ['auth.json']);
});

test('释放锁失败仍返回已切换结果，保留可恢复的 rollback 且阻止其他操作', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  let failRelease = true;
  const failureFs = { ...syncFs, rmdirSync(...args) {
    if (failRelease) throw Object.assign(new Error('synthetic-secret'), { code: 'EIO' });
    return syncFs.rmdirSync(...args);
  } };
  const store = createAccountStore(app.context, { home: app.home, syncFs: failureFs });
  const result = await store.stageSwitch(profile.id, expected());
  assert.equal(result.changed, true);
  assert.equal(result.id, profile.id);
  assert.equal(typeof result.rollback, 'function');
  assert.match(result.cleanupWarning, /锁未能释放/);
  assert.ok(!result.cleanupWarning.includes('synthetic'));
  assert.deepEqual(await fs.readFile(app.file), auth('two@example.test', 'workspace-two'));
  await rejectsCode(app.store.saveCurrent(expected('two@example.test', 'workspace-two')), 'BUSY');
  assert.equal(await result.rollback(), true);
  assert.deepEqual(await fs.readFile(app.file), auth());
  failRelease = false;
  assert.equal(await result.rollback(), false);
  assert.ok(!(await fs.readdir(app.home)).some(name => name.endsWith('.lock')));
});

test('创建 owner 失败仅清理原空目录，保留部分 owner 与替换目录', async t => {
  for (const outcome of ['empty', 'partial', 'replacement']) {
    const app = await setup(t);
    await app.put(auth());
    const lock = path.join(app.home, '.codex-multi-tab-account.lock');
    const store = createAccountStore(app.context, { home: app.home, syncFs: { ...syncFs,
      writeFileSync(file, ...args) {
        if (outcome === 'partial') syncFs.writeFileSync(file, '{partial', args.at(-1));
        if (outcome === 'replacement') {
          syncFs.renameSync(lock, path.join(app.home, 'old-lock'));
          syncFs.mkdirSync(lock);
        }
        throw Object.assign(new Error('synthetic-private-error'), { code: 'EIO' });
      },
    } });
    await rejectsCode(store.saveCurrent(expected()), 'STORAGE');
    assert.deepEqual(await fs.readFile(app.file), auth());
    assert.equal(app.values.size, 0);
    if (outcome === 'empty') await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    else {
      assert.equal((await fs.readdir(lock)).length, outcome === 'partial' ? 1 : 0);
      await rejectsCode(app.store.saveCurrent(expected()), 'BUSY');
    }
  }
});

test('同步释放删除 owner 后锁目录被替换时不删除新目录或恢复旧 owner', async t => {
  const app = await setup(t);
  await app.put(auth());
  const lock = path.join(app.home, '.codex-multi-tab-account.lock');
  const store = createAccountStore(app.context, { home: app.home, syncFs: { ...syncFs,
    unlinkSync(file) {
      syncFs.unlinkSync(file);
      syncFs.renameSync(lock, path.join(app.home, 'old-lock'));
      syncFs.mkdirSync(lock);
      syncFs.writeFileSync(path.join(lock, 'replacement'), 'keep');
    },
  } });
  const result = await store.saveCurrent(expected());
  assert.match(result.cleanupWarning, /锁未能释放/);
  assert.deepEqual(await fs.readdir(lock), ['replacement']);
  assert.equal(await fs.readFile(path.join(lock, 'replacement'), 'utf8'), 'keep');
});

test('残留锁被替换时 rollback 不复用他人锁，也不覆盖认证', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  const store = createAccountStore(app.context, { home: app.home, syncFs: { ...syncFs,
    rmdirSync() { throw Object.assign(new Error('synthetic'), { code: 'EIO' }); } } });
  const result = await store.stageSwitch(profile.id, expected());
  const lock = path.join(app.home, '.codex-multi-tab-account.lock');
  // Preserve the old inode at another path so its number cannot be immediately reused.
  await fs.rename(lock, path.join(app.home, 'old-lock'));
  await fs.mkdir(lock);
  await rejectsCode(result.rollback(), 'BUSY');
  assert.deepEqual(await fs.readFile(app.file), auth('two@example.test', 'workspace-two'));
  assert.ok((await fs.stat(lock)).isDirectory());
});

test('写前 guard 可取消切换且不泄露异常，并检测 guard 期间发生的凭据刷新', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  let calls = 0;
  await rejectsCode(app.store.stageSwitch(profile.id, expected(), async () => {
    calls++;
    throw new Error('synthetic-private-cancellation');
  }), 'STORAGE');
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(app.file), auth());
  const refreshed = auth(undefined, undefined, 'guard-refresh');
  await rejectsCode(app.store.stageSwitch(profile.id, expected(), () => app.put(refreshed)), 'CHANGED');
  assert.deepEqual(await fs.readFile(app.file), refreshed);
  assert.deepEqual(await fs.readdir(app.home), ['auth.json']);
});

test('准备临时文件期间外部刷新时拒绝覆盖', async t => {
  const app = await setup(t);
  await app.put(auth('two@example.test', 'workspace-two'));
  const profile = await app.store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  const refreshed = auth(undefined, undefined, 'external');
  const raceFs = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (file.endsWith('.tmp')) await app.put(refreshed);
    return handle;
  } };
  const store = createAccountStore(app.context, { home: app.home, fs: raceFs });
  await rejectsCode(store.stageSwitch(profile.id, expected()), 'CHANGED');
  assert.deepEqual(await fs.readFile(app.file), refreshed);
  assert.deepEqual(await fs.readdir(app.home), ['auth.json']);
});

test('拒绝 API Key、未知结构、JWT identity 不一致及过大认证文件', async t => {
  const app = await setup(t);
  for (const bytes of [Buffer.from('{"OPENAI_API_KEY":"synthetic-key"}'), Buffer.from('{invalid'),
    Buffer.from(JSON.stringify({ ...JSON.parse(auth()), other: 'unsupported' })),
    Buffer.from(JSON.stringify({ ...JSON.parse(auth()), OPENAI_API_KEY: 'synthetic-key' })),
    Buffer.from(JSON.stringify({ ...JSON.parse(auth()), tokens: { ...JSON.parse(auth()).tokens, account_id: 'other' } }))]) {
    await app.put(bytes);
    await rejectsCode(app.store.saveCurrent(expected()), 'INVALID_AUTH');
  }
  await app.put(Buffer.alloc(1024 * 1024 + 1));
  await rejectsCode(app.store.saveCurrent(expected()), 'UNSUPPORTED');
  assert.equal(app.values.size, 0);
});

test('拒绝 symlink home/auth/config，不读取链接目标', async t => {
  const app = await setup(t), other = await setup(t);
  await other.put(auth());
  await fs.symlink(other.file, app.file);
  await rejectsCode(app.store.saveCurrent(expected()), 'UNSUPPORTED');
  await fs.unlink(app.file);
  await fs.symlink(other.home, path.join(app.home, 'linked-home'));
  const linked = createAccountStore(app.context, { home: path.join(app.home, 'linked-home') });
  await rejectsCode(linked.checkSupport(), 'UNSUPPORTED');
  await fs.symlink(other.file, path.join(app.home, 'config.toml'));
  await rejectsCode(app.store.checkSupport(), 'UNSUPPORTED');
  assert.deepEqual(await fs.readFile(other.file), auth());
});

test('checkSupport 不读取 auth；根级认证模式和 workspace 限制保守校验', async t => {
  const app = await setup(t);
  await app.put(Buffer.from('invalid credentials are not read by checkSupport'));
  assert.deepEqual(await app.store.checkSupport(), { supported: true });
  for (const config of ['cli_auth_credentials_store = "keyring"', 'cli_auth_credentials_store = "auto"',
    'cli_auth_credentials_store = "ephemeral"', 'forced_login_method = "api"',
    '"cli_auth_credentials_store" = "keyring"', 'cli_auth_credentials_store = "fi\\u006ce"',
    'cli_auth_credentials_store = "file"\ncli_auth_credentials_store = "keyring"']) {
    await fs.writeFile(path.join(app.home, 'config.toml'), config);
    await rejectsCode(app.store.checkSupport(), 'UNSUPPORTED');
  }
  await fs.writeFile(path.join(app.home, 'config.toml'), 'cli_auth_credentials_store = "file" # comment\nforced_login_method = \'chatgpt\'\nforced_chatgpt_workspace_id = "workspace-two"');
  await app.put(auth());
  await rejectsCode(app.store.saveCurrent(expected()), 'UNSUPPORTED');
  await app.put(auth(undefined, 'workspace-two'));
  await app.store.saveCurrent(expected('one@example.test', 'workspace-two'));
  assert.deepEqual(parseAuthConfig(Buffer.from('[profiles.other]\ncli_auth_credentials_store="keyring"')), { store: 'file', workspaceId: null });
});

test('损坏 vault 与无效 ID/备注均使用固定错误，不暴露存储内容', async t => {
  const app = await setup(t);
  await app.put(auth());
  const profile = await app.store.saveCurrent(expected());
  for (const label of ['', ' ', 'x'.repeat(81), 'hello\nworld']) await rejectsCode(app.store.rename(profile.id, label), 'INVALID_LABEL');
  await rejectsCode(app.store.remove('../synthetic-refresh-secret'), 'NOT_FOUND');
  await rejectsCode(app.store.stageSwitch('x'.repeat(64), expected()), 'NOT_FOUND');
  const key = [...app.values.keys()][0];
  app.values.set(key, 'synthetic-refresh-broken');
  await rejectsCode(app.store.list(), 'STORAGE');
  assert.throws(() => parseAuth(Buffer.from('secret-json')), error => error.code === 'CODEX_MULTI_TAB_ACCOUNT_INVALID_AUTH' && !error.message.includes('secret-json'));
});

test('官方有效环境支持复杂多行配置，存储层不重复解析本地配置', async t => {
  const app = await setup(t);
  const config = 'developer_instructions = """\nlocal instructions\n"""\n[profiles.work]\ncli_auth_credentials_store = "keyring"';
  await fs.writeFile(path.join(app.home, 'config.toml'), config);
  await rejectsCode(app.store.checkSupport(), 'UNSUPPORTED');
  const store = createAccountStore(app.context, { home: app.home, readEnvironment: async () => ({
    supported: true, authStorage: 'file', home: app.home, forcedWorkspaceIds: [],
  }) });
  assert.deepEqual(await store.checkSupport(), { supported: true });
  await app.put(auth());
  const profile = await store.saveCurrent(expected());
  assert.equal(profile.email, 'one@example.test');
  assert.equal(await fs.readFile(path.join(app.home, 'config.toml'), 'utf8'), config);
});

test('官方有效环境拒绝非 file 存储、home 变化及不安全的 workspace 限制', async t => {
  const app = await setup(t);
  const valid = { supported: true, authStorage: 'file', home: app.home, forcedWorkspaceIds: [] };
  for (const invalid of [null, { supported: false }, { authStorage: 'keyring' }, { authStorage: 'auto' },
    { home: path.dirname(app.home) }, { home: 'relative-home' }, { home: `${app.home}\0` },
    { forcedWorkspaceIds: null }, { forcedWorkspaceIds: [''] }, { forcedWorkspaceIds: [123] },
    { forcedWorkspaceIds: ['unsafe\nworkspace'] }, { forcedWorkspaceIds: ['x'.repeat(513)] }]) {
    const store = createAccountStore(app.context, { home: app.home,
      readEnvironment: async () => invalid === null ? null : { ...valid, ...invalid } });
    await rejectsCode(store.checkSupport(), 'UNSUPPORTED');
  }
});

test('每次账号操作重读官方环境，回调失败的原始信息不泄露', async t => {
  const app = await setup(t);
  let calls = 0;
  let failure = false;
  const store = createAccountStore(app.context, { home: app.home, readEnvironment: async () => {
    calls++;
    if (failure) throw new Error('synthetic-private-config-LEAK');
    return { supported: true, authStorage: 'file', home: app.home, forcedWorkspaceIds: [] };
  } });
  await app.put(auth());
  const profile = await store.saveCurrent(expected());
  assert.equal(calls, 1);
  failure = true;
  for (const operation of [() => store.checkSupport(), () => store.list(), () => store.saveCurrent(expected()),
    () => store.rename(profile.id, 'work'), () => store.remove(profile.id), () => store.stageSwitch(profile.id, expected())]) {
    const before = calls;
    await assert.rejects(operation(), error => {
      assert.equal(error.code, 'CODEX_MULTI_TAB_ACCOUNT_STORAGE');
      assert.ok(!error.message.includes('LEAK'));
      assert.ok(!JSON.stringify(error).includes('LEAK'));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, before + 1);
  }
  failure = false;
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await fs.readFile(app.file), auth());
});

test('官方多个 workspace 限制同时校验当前和目标账号，写前再次验证环境', async t => {
  const app = await setup(t);
  let forcedWorkspaceIds = [];
  let authStorage = 'file';
  const store = createAccountStore(app.context, { home: app.home, readEnvironment: async () => ({
    supported: true, authStorage, home: app.home, forcedWorkspaceIds,
  }) });
  await app.put(auth('two@example.test', 'workspace-two'));
  const target = await store.saveCurrent(expected('two@example.test', 'workspace-two'));
  await app.put(auth());
  forcedWorkspaceIds = ['workspace-two', 'workspace-three'];
  await rejectsCode(store.saveCurrent(expected()), 'UNSUPPORTED');
  await rejectsCode(store.stageSwitch(target.id, expected()), 'UNSUPPORTED');
  forcedWorkspaceIds = ['workspace-one', 'workspace-three'];
  await rejectsCode(store.stageSwitch(target.id, expected()), 'UNSUPPORTED');
  forcedWorkspaceIds = ['workspace-one', 'workspace-two'];
  await rejectsCode(store.stageSwitch(target.id, expected(), async () => { authStorage = 'keyring'; }), 'UNSUPPORTED');
  assert.deepEqual(await fs.readFile(app.file), auth());
  authStorage = 'file';
  const result = await store.stageSwitch(target.id, expected());
  assert.equal(result.changed, true);
  assert.deepEqual(await fs.readFile(app.file), auth('two@example.test', 'workspace-two'));
  assert.equal(await result.rollback(), true);
});
