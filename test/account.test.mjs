/**
 * dsh-plugin-github — GitHub 账号绑定测试
 *
 * 覆盖：账号存储（凭据服务后端 / 文件后端）、绑定与切换语义、
 * 首次使用时的自动引导（含用户跳过、环境不可交互）、以及 token 绝不外泄。
 *
 * 运行：node test/account.test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  createRunner,
  fakeContext,
  loadPlugin,
  makeUpstream,
  call,
  withFakeFetch,
} from './harness.mjs'
import {
  accountIdFor,
  accountView,
  createAccountManager,
  createCredentialsStore,
  createFileStore,
  selectStore,
} from '../src/store.js'
import { extractToken, isSkipAnswer } from '../src/prompt.js'

const runner = createRunner('account.test.mjs')

/** 造一个假的 GitHub /user 响应，并按 token 返回不同身份。 */
function identityFetcher(map) {
  const seen = []
  const fetchImpl = async (url, init) => {
    const token = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '')
    seen.push({ url: String(url), token })
    const identity = map[token]
    if (identity === undefined) {
      return new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ login: identity.login, name: identity.name }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-oauth-scopes': identity.scopes ?? 'repo' },
    })
  }
  return { fetchImpl, seen }
}

/** 直接测 store + manager（不经插件），方便覆盖后端细节。 */
async function managerWith(store, map) {
  const { fetchImpl } = identityFetcher(map)
  return {
    manager: createAccountManager({
      store,
      lookupIdentity: async token => {
        const response = await fetchImpl('/user', { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error('token 校验失败')
        const body = await response.json()
        return { login: body.login, name: body.name, scopes: response.headers.get('x-oauth-scopes') }
      },
    }),
    fetchImpl,
  }
}

await runner.test('accountIdFor 规范化登录名，拒绝非法输入', async () => {
  assert.equal(accountIdFor('Octocat'), 'octocat')
  assert.equal(accountIdFor('My-User_99'), 'my-user-99')
  assert.equal(accountIdFor('  A.B  '), 'a-b')
  assert.throws(() => accountIdFor(''), /无法从登录名/)
  assert.throws(() => accountIdFor('---'), /无法从登录名/)
})

await runner.test('文件后端：绑定 → 切换 → 删除，落盘内容不含多余字段', async context => {
  const root = await context.setup()
  const file = path.join(root, 'accounts.json')
  const store = createFileStore(file)
  const { manager } = await managerWith(store, {
    t1: { login: 'alice', name: 'Alice' },
    t2: { login: 'bob' },
  })

  assert.deepEqual(await manager.list(), [])
  assert.equal(await manager.active(), undefined)

  const alice = await manager.bind('t1', { source: 'test' })
  assert.equal(alice.id, 'alice')
  assert.equal(alice.login, 'alice')
  assert.equal((await manager.active()).login, 'alice', '绑定后应自动成为当前账号')

  const bob = await manager.bind('t2')
  assert.equal((await manager.active()).login, 'bob', '再次绑定也应切换过去')

  // 切换回 alice（按登录名，大小写不敏感）
  await manager.use('ALICE')
  assert.equal((await manager.activeId()), 'alice')

  const listed = await manager.list()
  assert.equal(listed.length, 2)
  assert.equal(listed.filter(entry => entry.__active).length, 1)
  assert.equal(listed.find(entry => entry.__active).login, 'alice')

  const removed = await manager.remove('bob')
  assert.deepEqual(removed, { id: 'bob', wasActive: false })
  assert.equal((await manager.list()).length, 1)

  // 落盘文件：可被重新读取，且 token 只在插件自有文件里
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.active, 'alice')
  assert.deepEqual(raw.accounts.map(entry => entry.id), ['alice'])
  assert.equal(raw.accounts[0].token, 't1')

  // 新实例应能从磁盘恢复
  const reopened = createFileStore(file)
  const reopenedManager = createAccountManager({
    store: reopened,
    lookupIdentity: async () => ({ login: 'alice' }),
  })
  assert.equal((await reopenedManager.active()).login, 'alice')
})

await runner.test('删除当前账号后指针清空，不会指向不存在的账号', async context => {
  const root = await context.setup()
  const store = createFileStore(path.join(root, 'a.json'))
  const { manager } = await managerWith(store, { t1: { login: 'solo' } })
  await manager.bind('t1')
  const removed = await manager.remove('solo')
  assert.equal(removed.wasActive, true)
  assert.equal(await manager.activeId(), undefined)
  assert.equal(await manager.active(), undefined)
})

await runner.test('凭据服务后端：record 读写、active 指针、token 不被枚举', async () => {
  /** 极简内存版凭据服务（含 modifyRecord / deleteRecord / listRecords）。 */
  const records = new Map()
  const provider = {
    async listRecords() {
      return [...records.entries()].map(([key, record]) => ({ key, kind: record.kind }))
    },
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }

  const store = createCredentialsStore(provider)
  assert.equal(store.kind, 'credentials')

  const { manager } = await managerWith(store, { t1: { login: 'carol', name: 'Carol' } })
  await manager.bind('t1')
  assert.equal((await manager.active()).login, 'carol')

  // record 的 key 必须符合 `<scope>/<id>`，且 token 存在 key 字段里
  const record = records.get('github-repo/carol')
  assert.ok(record, '应写入 github-repo/carol')
  assert.equal(record.kind, 'api-key')
  assert.equal(record.key, 't1')
  assert.equal(record.env.GITHUB_LOGIN, 'carol')
  assert.equal(records.get('github-repo/active').env.ACTIVE, 'carol')

  // 列举只能看到 key 与 kind，看不到 token
  const entries = await provider.listRecords()
  assert.ok(!JSON.stringify(entries).includes('t1'), '枚举结果绝不能带 token')

  await manager.remove('carol')
  assert.equal(records.has('github-repo/carol'), false)
})

await runner.test('selectStore：有凭据服务用凭据服务，没有则回退到文件', async context => {
  const root = await context.setup()
  const withService = selectStore({
    credentials: { listRecords: async () => [], readRecord: async () => undefined },
    dshHome: root,
  })
  assert.equal(withService.store.kind, 'credentials')

  const without = selectStore({ credentials: undefined, dshHome: root })
  assert.equal(without.store.kind, 'file')
  assert.match(without.reason, /凭据服务未挂载/)

  // 能力不全的 provider 也应回退（不同 DSH 组合下实现并不一致）
  const partial = selectStore({ credentials: { resolve: async () => undefined }, dshHome: root })
  assert.equal(partial.store.kind, 'file', '缺少 listRecords/readRecord 时必须回退')
})

await runner.test('accountView / extractToken / isSkipAnswer 的边界', async () => {
  const view = accountView({ id: 'a', login: 'alice', token: 'SECRET', scopes: 'repo' }, 'a')
  assert.equal(view.login, 'alice')
  assert.equal(view.active, true)
  assert.ok(!JSON.stringify(view).includes('SECRET'), 'accountView 不能带 token')
  assert.equal('name' in view, false, '未设置的字段不应出现')

  assert.equal(extractToken('ghp_' + 'a'.repeat(36)), 'ghp_' + 'a'.repeat(36))
  assert.equal(extractToken('  ghp_' + 'b'.repeat(40) + '  '), 'ghp_' + 'b'.repeat(40))
  assert.equal(extractToken('github_pat_' + 'c'.repeat(30)), 'github_pat_' + 'c'.repeat(30))
  assert.equal(extractToken('这是我的 token：ghp_' + 'd'.repeat(36) + '，请绑定'), 'ghp_' + 'd'.repeat(36))
  assert.equal(extractToken('随便一句话'), undefined)
  assert.equal(extractToken(''), undefined)
  assert.equal(isSkipAnswer('跳过，暂不绑定'), true)
  assert.equal(isSkipAnswer('稍后'), true)
  assert.equal(isSkipAnswer('Skip'), true)
  assert.equal(isSkipAnswer('使用已有的环境变量'), false)
})

await runner.test('插件：gh_account 的 bind/list/use/remove/status 全流程', async context => {
  const root = await context.setup()
  const storeFile = path.join(root, 'accounts.json')
  const plugin = await loadPlugin()
  const { ctx, tools, logs } = fakeContext()
  plugin.apply(ctx, {
    workspaceRoot: root,
    allowRepos: ['me/*'],
    accountStorePath: storeFile,
  })

  const { fetchImpl, seen } = identityFetcher({ tA: { login: 'alice' }, tB: { login: 'bob', scopes: 'repo,workflow' } })
  await withFakeFetch(fetchImpl, async () => {
    // 初始：未绑定
    const initial = await call(tools, 'gh_account', { action: 'list' })
    assert.equal(initial.count, 0)
    assert.equal(initial.backend, 'file')
    assert.match(initial.hint, /bind/)

    // bind（直接给 token）
    const bound = await call(tools, 'gh_account', { action: 'bind', token: 'tA' })
    assert.equal(bound.account.login, 'alice')
    assert.equal(bound.active, 'alice')
    assert.ok(!JSON.stringify(bound).includes('tA'), '返回值绝不能回显 token')
    assert.equal(seen.at(-1).token, 'tA', '绑定前必须先用该 token 校验身份')

    // 再绑一个 → 自动切换
    const second = await call(tools, 'gh_account', { action: 'bind', token: 'tB' })
    assert.equal(second.account.login, 'bob')
    assert.equal(second.account.scopes, 'repo,workflow')

    // list / status
    const listed = await call(tools, 'gh_account', { action: 'list' })
    assert.deepEqual(listed.accounts.map(entry => entry.login), ['alice', 'bob'])
    assert.equal(listed.active, 'bob')
    assert.equal(listed.accounts.find(entry => entry.active).login, 'bob')

    const status = await call(tools, 'gh_account', { action: 'status' })
    assert.equal(status.configured, true)
    assert.equal(status.identity.login, 'bob')

    // use 切回 alice，并确认后续 status 用的是新账号
    const used = await call(tools, 'gh_account', { action: 'use', login: 'alice' })
    assert.equal(used.account.login, 'alice')
    const status2 = await call(tools, 'gh_account', { action: 'status' })
    assert.equal(status2.identity.login, 'alice')
    assert.equal(seen.at(-1).token, 'tA', '切换后应使用 alice 的 token')

    // remove
    const removed = await call(tools, 'gh_account', { action: 'remove', login: 'bob' })
    assert.equal(removed.removed, 'bob')
    assert.equal((await call(tools, 'gh_account', { action: 'list' })).count, 1)

    // 无效 token 不应被存下来
    await expectReject(() => call(tools, 'gh_account', { action: 'bind', token: 'bogus' }), /token 校验失败/)
    assert.equal((await call(tools, 'gh_account', { action: 'list' })).count, 1)

    // 未知账号
    await expectReject(() => call(tools, 'gh_account', { action: 'use', login: 'nobody' }), /找不到账号/)
  })

  assert.equal(logs.filter(([level]) => level === 'error').length, 0)
})

await runner.test('已绑定账号优先于环境变量（默认用绑定账号）', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: root, accountStorePath: path.join(root, 'a.json') })

  const saved = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'from-env'
  try {
    const { fetchImpl, seen } = identityFetcher({ tBound: { login: 'bound' }, 'from-env': { login: 'envuser' } })
    await withFakeFetch(fetchImpl, async () => {
      await call(tools, 'gh_account', { action: 'bind', token: 'tBound' })
      const status = await call(tools, 'gh_account', { action: 'status' })
      assert.equal(status.identity.login, 'bound', '应优先使用绑定的账号')
      assert.equal(seen.at(-1).token, 'tBound')
      // gh_api 也应走绑定账号
      await call(tools, 'gh_api', { endpoint: '/user' })
      assert.equal(seen.at(-1).token, 'tBound', 'gh_api 必须用绑定账号的 token')
    })
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved
  }
})

await runner.test('首次需要凭据时自动弹出绑定引导，绑定后立即继续该操作', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const asked = []
    const userQuestions = {
      async ask(request) {
        asked.push(request)
        // 模拟用户在输入框里粘贴了 token
        return { answers: [{ id: 'github_bind', selected: [], custom: 'ghp_' + 'x'.repeat(36) }] }
      },
    }
    const credentials = {
      async resolve() { return undefined },
      async describe() { return { configured: false, writable: true } },
    }
    const { ctx, tools } = fakeContext({ credentials, userQuestions })
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: [upstream.allowRule],
      allowPush: true,
      allowNonGithubRemotes: true,
      accountStorePath: path.join(root, 'accounts.json'),
      gitAuthorName: 't',
      gitAuthorEmail: 't@e',
    })

    const pastedToken = 'ghp_' + 'x'.repeat(36)
    const { fetchImpl, seen } = identityFetcher({ [pastedToken]: { login: 'newbie' } })

    await withFakeFetch(fetchImpl, async () => {
      // 第一步：clone。公开仓库可以匿名拉取，所以这里不会弹窗。
      const cloned = await call(
        tools,
        'gh_repo',
        { repo: upstream.repo, action: 'clone' },
        { agent: { fake: 'agent' } },
      )
      assert.equal(cloned.ok, true, `clone 应成功：${cloned.error ?? ''}`)
      assert.equal(asked.length, 0, '读取公开仓库不需要凭据，不应弹窗')

      // 第二步：推送需要写权限 → 应弹出绑定引导，并在绑定后继续完成这次推送。
      const pushed = await call(
        tools,
        'gh_push',
        { repo: upstream.repo },
        { agent: { fake: 'agent' } },
      )
      assert.equal(pushed.ok, true, `绑定后推送应成功：${pushed.error ?? ''}`)

      // 弹过引导，且问题里明确说明是在要 PAT
      assert.equal(asked.length, 1, '应恰好弹一次绑定引导')
      assert.match(asked[0].questions[0].question, /Personal Access Token/)
      assert.equal(asked[0].agent.fake, 'agent', '必须把发起调用的 agent 一起传下去')

      // 引导输入的 token 被用来校验身份
      assert.ok(seen.some(entry => entry.token === pastedToken), '应使用用户粘贴的 token 校验身份')

      // 绑定已持久化，后续调用不再询问
      const listed = await call(tools, 'gh_account', { action: 'list' })
      assert.equal(listed.count, 1)
      assert.equal(listed.accounts[0].login, 'newbie')

      await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
      await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'x.txt', content: 'x\n' })
      await call(tools, 'gh_commit', { repo: upstream.repo, message: 'feat: x' })
      await call(tools, 'gh_push', { repo: upstream.repo })
      assert.equal(asked.length, 1, '已绑定后不应再弹引导')
    })
  } finally {
    await upstream.http.close()
  }
})

await runner.test('跳过引导 / 无问答服务时不阻断操作；确实无法继续时给出可操作错误', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const base = {
      workspaceRoot: context.workspace,
      // 同时允许本地测试远端与 me/*，这样 create 的失败原因才是「没有凭据」而不是白名单。
      allowRepos: [upstream.allowRule, 'me/*'],
      allowPush: true,
      allowNonGithubRemotes: true,
    }
    const { runGit, repoDirName } = await import('../src/git.js')
    const dir = path.join(context.workspace, repoDirName(upstream.slug))
    assert.equal((await runGit(['clone', upstream.repo, dir])).ok, true)

    // 情形 1：用户选择「跳过」→ 尊重选择，不阻断（本地/无凭据远端照样能推）。
    const skipContext = fakeContext({
      credentials: undefined,
      userQuestions: { async ask() { return { answers: [{ id: 'github_bind', selected: ['跳过，暂不绑定'] }] } } },
    })
    plugin.apply(skipContext.ctx, { ...base, accountStorePath: path.join(root, 'skip.json') })
    const skippedPush = await call(skipContext.tools, 'gh_push', { repo: upstream.slug }, { agent: { fake: 1 } })
    assert.equal(skippedPush.ok, true, '跳过绑定后不应阻断本地远端上的推送')

    // 情形 2：完全没有问答服务（子代理 / 无 UI 运行时）→ 同样不阻断、也不挂死。
    const noUi = fakeContext({ credentials: undefined, userQuestions: null })
    plugin.apply(noUi.ctx, {
      ...base,
      allowApiWrite: true,
      accountStorePath: path.join(root, 'noui.json'),
    })
    const pushed = await call(noUi.tools, 'gh_push', { repo: upstream.slug }, { agent: { fake: 1 } })
    assert.equal(pushed.ok, true, '无问答服务时不应阻断，更不应挂死')

    // 情形 3：确实无法继续的操作（创建远端仓库必须有 token）→ 报错要给出绑定方式。
    const error = await expectReject(
      () => call(noUi.tools, 'gh_repo',
        { repo: 'me/newrepo', action: 'create', name: 'newrepo', owner: 'me' },
        { agent: { fake: 1 } }),
      /还没有绑定任何账号|需要 GitHub 凭据|无法写入|401/, 
    )
    assert.match(error.message, /gh_account action=bind|credentials\.yaml|环境变量/, '错误里要给出绑定方式')

    // 情形 4：配置里关掉自动引导 → 不弹窗，但仍不阻断。
    let asked = 0
    const disabled = fakeContext({
      credentials: undefined,
      userQuestions: { async ask() { asked += 1; return { answers: [] } } },
    })
    plugin.apply(disabled.ctx, {
      ...base,
      allowAutoBind: false,
      accountStorePath: path.join(root, 'off.json'),
    })
    const offPush = await call(disabled.tools, 'gh_push', { repo: upstream.slug }, { agent: { fake: 1 } })
    assert.equal(offPush.ok, true)
    assert.equal(asked, 0, '关闭自动引导后不应弹窗')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_account 返回值始终是宿主可接受的无损 JSON', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext({ credentials: undefined, userQuestions: undefined })
  plugin.apply(ctx, { workspaceRoot: root, accountStorePath: path.join(root, 'a.json') })

  const { fetchImpl } = identityFetcher({ tA: { login: 'alice' } })
  await withFakeFetch(fetchImpl, async () => {
    for (const args of [
      { action: 'list' },
      { action: 'bind', token: 'tA' },
      { action: 'status' },
      { action: 'use', login: 'alice' },
      { action: 'remove', login: 'alice' },
      { action: 'list' },
    ]) {
      const value = await call(tools, 'gh_account', args)
      const problems = []
      const walk = (node, label) => {
        if (node === undefined) { problems.push(`${label}: undefined`); return }
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${label}[${index}]`)); return }
        if (Object.getPrototypeOf(node) !== Object.prototype) problems.push(`${label}: 非普通对象`)
        for (const [key, item] of Object.entries(node)) walk(item, `${label}.${key}`)
      }
      walk(value, JSON.stringify(args))
      assert.deepEqual(problems, [], `gh_account ${JSON.stringify(args)} 含非法值：${problems.join('；')}`)
      assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    }
  })
})

/**
 * 断言一定会被拒绝。
 * @param {() => unknown} operation
 * @param {RegExp} pattern
 */
async function expectReject(operation, pattern) {
  let failed
  try {
    const value = await operation()
    throw new Error(`expectReject：本应被拒绝，却成功返回：${JSON.stringify(value)?.slice(0, 160)}`)
  } catch (error) {
    if (error instanceof Error && String(error.message).includes('本应被拒绝')) throw error
    failed = error
  }
  const message = failed instanceof Error ? failed.message : String(failed)
  if (!pattern.test(message)) {
    throw new Error(`expectReject：错误信息与 ${pattern} 不匹配，实际是：${message}`)
  }
  return failed
}

runner.finish()
