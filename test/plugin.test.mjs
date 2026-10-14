/**
 * dsh-plugin-github — 插件端到端测试
 *
 * 用假的 ctx 调用真实的 apply()，拿到注册的工具定义后逐条执行真实实现：
 * 真实 git 子进程、真实文件系统、真实 smart HTTP（`git http-backend`），不依赖外网。
 *
 * 运行：node test/plugin.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createRunner,
  fakeContext,
  loadPlugin,
  makeUpstream,
  call,
  withFakeFetch,
} from './harness.mjs'

/**
 * 断言一定会被拒绝。
 *
 * 每个操作都用「显式 try/catch 包住 await」——在这种环境里（Node 24.19 + 自定义
 * harness），把「调用」和「处理拒绝」拆成两个表达式时，拒绝有可能在
 * `await p.then(onOk, onErr)` 之前就逃逸成进程级未处理拒绝，导致测试进程直接退出。
 * try/catch 包住 await 在两种形态（同步抛出 / promise 拒绝）下都稳定。
 * @param {() => unknown} operation
 * @param {RegExp} pattern
 * @param {string} [label]
 */
async function expectReject(operation, pattern, label) {
  let failed
  try {
    const value = await operation()
    throw new Error(`${label ?? 'expectReject'}：本应被拒绝，却成功返回：${JSON.stringify(value)?.slice(0, 200)}`)
  } catch (error) {
    if (error instanceof Error && String(error.message).includes('本应被拒绝')) throw error
    failed = error
  }
  const message = failed instanceof Error ? failed.message : String(failed)
  if (!pattern.test(message)) {
    throw new Error(`${label ?? 'expectReject'}：错误信息与 ${pattern} 不匹配，实际是：${message}`)
  }
  return failed
}

const runner = createRunner('plugin.test.mjs')

const EXPECTED_TOOLS = ['gh_account', 'gh_api', 'gh_commit', 'gh_config', 'gh_file', 'gh_pull', 'gh_push', 'gh_repo']

await runner.test('apply 注册全部工具，且每个都声明 parameters + output.schema + output.render', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd() })

  assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS)
  for (const [name, definition] of tools) {
    assert.equal(definition.parameters.type, 'object', `${name}.parameters 必须是 object 根`)
    assert.equal(typeof definition.parameters.properties, 'object', `${name}.parameters 需要 properties`)
    // 真实 dsh-tools 会断言 output.schema 属于受支持子集；注解式 schema 只允许注解关键字。
    const keys = Object.keys(definition.output.schema)
    assert.ok(
      keys.every(key => ['description', 'title', 'default', 'examples'].includes(key)),
      `${name} 的 output.schema 应为注解式 schema，实际键：${keys.join(', ')}`,
    )
    // 必填参数必须写进 JSON Schema 的 required 数组。
    const declaredRequired = definition.parameters.required ?? []
    for (const key of declaredRequired) {
      assert.ok(definition.parameters.properties[key], `${name} 的 required "${key}" 未在 properties 中声明`)
    }
  }
  assert.deepEqual(tools.get('gh_repo').parameters.required, ['repo', 'action'])
  assert.deepEqual(tools.get('gh_commit').parameters.required, ['repo', 'message'])
})

await runner.test('未知配置键会告警但不影响注册', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools, logs } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd(), allowPushes: true })
  assert.equal(tools.size, EXPECTED_TOOLS.length)
  assert.ok(logs.some(([level, text]) => level === 'warn' && text.includes('allowPushes')))
})

await runner.test('clone → 读文件 → edit → status → diff → commit → push 全链路', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true,
      allowPush: true,
      gitAuthorName: 'dsh-test',
      gitAuthorEmail: 'dsh@example.com',
    })

    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    assert.equal(cloned.ok, true, `clone 失败：${cloned.error ?? ''}`)
    assert.equal(cloned.action, 'clone')
    assert.equal(cloned.head.subject, 'init')
    assert.equal(cloned.auth, 'anonymous')
    assert.equal(path.basename(cloned.path), upstream.dirName)

    const listed = await call(tools, 'gh_file', { repo: upstream.repo, action: 'list' })
    const names = listed.entries.map(entry => entry.name)
    assert.ok(names.includes('README.md') && names.includes('src.txt'), `列表缺少文件：${names.join(', ')}`)
    assert.ok(!names.includes('.git'), '.git 不应出现在列表里')

    const got = await call(tools, 'gh_file', {
      repo: upstream.repo, action: 'get', path: 'src.txt', startLine: 2, endLine: 3,
    })
    assert.equal(got.totalLines, 4)
    assert.match(got.content, /     2│ b/)
    assert.match(got.content, /     3│ c/)

    const edited = await call(tools, 'gh_file', {
      repo: upstream.repo, action: 'edit', path: 'src.txt', oldText: 'b\n', newText: 'b-edited\n',
    })
    assert.equal(edited.replacements, 1)
    assert.equal(await readFile(path.join(cloned.path, 'src.txt'), 'utf8'), 'a\nb-edited\nc\n')

    const status = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    assert.equal(status.clean, false)
    assert.deepEqual(status.files.map(entry => entry.path), ['src.txt'])

    const diff = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'diff' })
    assert.match(diff.diff, /-b/)
    assert.match(diff.diff, /\+b-edited/)

    const committed = await call(tools, 'gh_commit', {
      repo: upstream.repo, message: 'fix: 改一行', paths: ['src.txt'],
    })
    assert.equal(committed.ok, true)
    assert.equal(committed.pushed, false)
    assert.notEqual(committed.head.sha, cloned.head.sha)

    const log = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 5 })
    assert.equal(log.commits[0].subject, 'fix: 改一行')
    assert.equal(log.commits[0].author, 'dsh-test')

    const branches = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'branches' })
    assert.ok(branches.branches.some(entry => entry.name === 'main' && entry.current))

    const pushed = await call(tools, 'gh_push', { repo: upstream.repo })
    assert.equal(pushed.ok, true, `push 失败：${pushed.error ?? ''}`)

    // 远端应真的收到提交：直接用另一个克隆验证。
    const { runGit } = await import('../src/git.js')
    const fresh = path.join(root, 'fresh')
    const recloned = await runGit(['clone', upstream.repo, fresh])
    assert.equal(recloned.ok, true, `二次克隆失败：${recloned.stderr}`)
    const remoteLog = await runGit(['log', '--pretty=format:%s', '-n', '1'], { cwd: fresh })
    assert.equal(remoteLog.stdout.trim(), 'fix: 改一行')

    const verify = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    assert.equal(verify.action, 'fetch', '已存在的克隆应走 fetch 而不是重新 clone')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_commit { push: true } 一步提交并推送', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true,
      allowPush: true,
      gitAuthorName: 'dsh-test',
      gitAuthorEmail: 'dsh@example.com',
    })

    await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'new/note.md', content: '# 新文件\n' })
    const committed = await call(tools, 'gh_commit', {
      repo: upstream.repo, message: 'feat: 新增说明', push: true,
    })
    assert.equal(committed.pushed.ok, true, `推送失败：${committed.pushed.error ?? ''}`)
    assert.equal(committed.stagedFiles.length, 1)

    const { runGit } = await import('../src/git.js')
    const fresh = path.join(root, 'fresh')
    assert.equal((await runGit(['clone', upstream.repo, fresh])).ok, true)
    const subject = await runGit(['log', '--pretty=format:%s', '-n', '1'], { cwd: fresh })
    assert.equal(subject.stdout.trim(), 'feat: 新增说明')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_pull 把远端新提交拉回本地', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true, allowPush: true })
    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    // 在「另一个开发者」的克隆里推一个新提交到远端。
    const { runGit } = await import('../src/git.js')
    const other = path.join(root, 'other')
    assert.equal((await runGit(['clone', upstream.repo, other])).ok, true)
    const author = ['-c', 'user.name=other', '-c', 'user.email=other@example.com']
    await import('node:fs/promises').then(fs => fs.writeFile(path.join(other, 'remote.txt'), '来自远端\n'))
    assert.equal((await runGit([...author, 'add', '.'], { cwd: other })).ok, true)
    assert.equal((await runGit([...author, 'commit', '-m', 'feat: 远端新增'], { cwd: other })).ok, true)
    assert.equal((await runGit(['push', 'origin', 'main'], { cwd: other })).ok, true)

    const pulled = await call(tools, 'gh_pull', { repo: upstream.repo })
    assert.equal(pulled.ok, true, `pull 失败：${pulled.error ?? ''}`)
    assert.equal(pulled.changed, true)
    assert.equal(await readFile(path.join(cloned.path, 'remote.txt'), 'utf8'), '来自远端\n')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('allowPush=false 拒绝推送；白名单外仓库拒绝任何写入', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true, allowPush: false })

    await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'x.txt', content: 'x\n' })
    await expectReject(
      () => call(tools, 'gh_commit', { repo: upstream.repo, message: 'x', push: true }),
      /allowPush/,
    )
    await expectReject(() => call(tools, 'gh_push', { repo: upstream.repo }), /allowPush/)

    // 提交仍然落到了本地（拒绝只针对远端写入）。
    const status = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    assert.equal(status.clean, true, '提交后工作区应为干净状态')

    await expectReject(() => call(tools, 'gh_push', { repo: 'someone/other-repo' }), /allowRepos/)
    await expectReject(
      () => call(tools, 'gh_repo', { repo: 'someone/other-repo', action: 'clone' }),
      /allowRepos/,
    )
    await expectReject(
      () => call(tools, 'gh_api', { endpoint: '/repos/someone/other', repo: 'someone/other' }),
      /allowRepos/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_file edit 的 count 校验、put 的 overwrite 保护、路径越界防护', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true })

    await expectReject(
      () => call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' }),
      /本地还没有|先调用 gh_repo/,
      '未克隆时应给出可操作的提示',
    )

    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'notes.txt', content: 'same\nsame\n' })
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'notes.txt', content: 'again\n' }),
      /overwrite/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: 'same\n', newText: 'x\n' }),
      /出现 2 次/,
    )
    const replaced = await call(tools, 'gh_file', {
      repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: 'same\n', newText: 'x\n', count: 2,
    })
    assert.equal(replaced.replacements, 2)
    assert.equal(await readFile(path.join(cloned.path, 'notes.txt'), 'utf8'), 'x\nx\n')
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: '不存在', newText: 'y' }),
      /找不到 oldText/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: '../../etc/passwd' }),
      /路径越界/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('参数校验：缺必填 / 类型错误 / 未知 action', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd() })

  await expectReject(() => call(tools, 'gh_repo', { repo: 'a/b' }), /缺少必填参数 action/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'a/b', action: 'nope' }), /不支持的 action/)
  await expectReject(
    () => call(tools, 'gh_repo', { repo: 'a/b', action: 'clone', depth: 'deep' }),
    /depth 应为 number/,
  )
  await expectReject(
    () => call(tools, 'gh_commit', { repo: 'a/b', message: 'm', paths: [1, 2] }),
    /元素应全部是 string/,
  )
  await expectReject(() => call(tools, 'gh_file', { repo: 'a/b', action: 'get' }), /需要 path/)
  await expectReject(() => call(tools, 'gh_api', { endpoint: '/user', method: 'TRACE' }), /不支持的 method/)
  await expectReject(() => call(tools, 'gh_api', { endpoint: '/user/following/x', method: 'PUT' }), /allowApiWrite/)
  await expectReject(() => call(tools, 'gh_config', { action: 'set' }), /需要 token 参数/)
})

await runner.test('gh_config：凭据服务可用时写入/回显/删除，且结果绝不回显 token', async () => {
  const store = new Map()
  const credentials = {
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
    async describe(ref) {
      return { configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true }
    },
  }

  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext({ credentials })

  await withFakeFetch(async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.github\.com\/user/)
    assert.equal(init?.headers?.authorization, 'Bearer ghp_test_token_value')
    return new Response(JSON.stringify({ login: 'octocat', id: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'x-oauth-scopes': 'repo' },
    })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), tokenRef: 'MY_GH_TOKEN' })

    const before = await call(tools, 'gh_config', { action: 'status' })
    assert.equal(before.configured, false)
    assert.equal(before.credentials_service, 'mounted')

    const set = await call(tools, 'gh_config', { action: 'set', token: 'ghp_test_token_value' })
    assert.equal(set.ok, true)
    assert.equal(store.get('MY_GH_TOKEN'), 'ghp_test_token_value')
    assert.ok(!JSON.stringify(set).includes('ghp_test_token_value'), '工具结果绝不能回显 token')

    const after = await call(tools, 'gh_config', { action: 'status' })
    assert.equal(after.configured, true)
    assert.equal(after.identity.login, 'octocat')
    assert.equal(after.identity.scopes, 'repo')

    const unset = await call(tools, 'gh_config', { action: 'unset' })
    assert.equal(unset.ok, true)
    assert.equal(store.has('MY_GH_TOKEN'), false)
  })

  // 没有凭据服务时：set 失败并给出环境变量替代方案。
  const plain = fakeContext()
  plugin.apply(plain.ctx, { workspaceRoot: process.cwd(), tokenRef: 'MY_GH_TOKEN' })
  await expectReject(
    () => call(plain.tools, 'gh_config', { action: 'set', token: 'x' }),
    /ctx\.credentials|环境变量/,
  )
})

await runner.test('gh_api：GET 走通，写操作受 allowApiWrite 与白名单双约束', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const calls = []

  await withFakeFetch(async (url, init) => {
    calls.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify({ ok: true, items: [1, 2, 3] }), {
      status: init?.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '42' },
    })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowApiWrite: true, allowRepos: ['me/*'] })

    const read = await call(tools, 'gh_api', { endpoint: '/repos/me/demo/pulls', query: '{"state":"open"}' })
    assert.equal(read.status, 200)
    assert.equal(read.rate_remaining, 42)
    assert.match(read.data, /"ok": true/)
    assert.match(calls[0].url, /state=open/)

    const created = await call(tools, 'gh_api', {
      endpoint: '/repos/me/demo/issues', method: 'POST', repo: 'me/demo', body: '{"title":"hi"}',
    })
    assert.equal(created.status, 201)
    assert.equal(calls[1].method, 'POST')

    await expectReject(
      () => call(tools, 'gh_api', { endpoint: '/repos/other/x/issues', method: 'POST', repo: 'other/x', body: '{}' }),
      /allowRepos/,
    )
    await expectReject(
      () => call(tools, 'gh_api', { endpoint: '/user', method: 'POST', body: '{}' }),
      /无法确定目标仓库/,
    )
    await expectReject(() => call(tools, 'gh_api', { endpoint: '/user', query: 'not json' }), /不是合法 JSON/)
    await expectReject(() => call(tools, 'gh_api', { endpoint: 'https://evil.example.com/user' }), /只允许访问/)
  })
})

await runner.test('auth：凭据服务 → 环境变量 → .env 的回退顺序', async () => {
  const { resolveToken, parseDotenv } = await import('../src/auth.js')

  assert.deepEqual(parseDotenv('A=1\n# 注释\nexport B="two"\nC=\'\'\nbad line\n'), { A: '1', B: 'two' })

  const fromService = await resolveToken({
    credentials: { async resolve() { return { value: 'svc-token', source: 'file' } } },
    tokenRef: 'GITHUB_TOKEN',
  })
  assert.equal(fromService.token, 'svc-token')
  assert.equal(fromService.source, 'dsh-credentials(file)')

  const previous = process.env.GITHUB_TOKEN
  try {
    delete process.env.GITHUB_TOKEN
    const none = await resolveToken({ credentials: undefined, tokenRef: 'GITHUB_TOKEN', dotenv: false })
    assert.equal(none.configured, false)
    assert.equal(none.token, undefined)

    process.env.GITHUB_TOKEN = 'env-token'
    const fromEnv = await resolveToken({ credentials: undefined, tokenRef: 'GITHUB_TOKEN', dotenv: false })
    assert.equal(fromEnv.token, 'env-token')
    assert.equal(fromEnv.source, 'env:GITHUB_TOKEN')

    // 凭据服务抛错时也要回退，而不是让整次调用失败。
    const fallback = await resolveToken({
      credentials: { async resolve() { throw new Error('boom') } },
      tokenRef: 'GITHUB_TOKEN',
      dotenv: false,
    })
    assert.equal(fallback.token, 'env-token')
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})

await runner.test('auth.js 不做任何直接打印（避免 token 泄漏进日志）', async () => {
  const source = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8')
  assert.ok(!/console\.(log|error|warn|debug)/.test(source), 'auth.js 不应直接打印任何东西')
})

await runner.test('repos.js 白名单语法：owner/repo、owner/*、*/repo、*', async () => {
  const { normalizeConfig, repoAllowed } = await import('../src/repos.js')
  const cfg = normalizeConfig({ allowRepos: 'me/*,other/exact', workspaceRoot: process.cwd() }, process.cwd())
  assert.deepEqual(cfg.allowRepos, ['me/*', 'other/exact'])
  assert.equal(repoAllowed(cfg, 'me/anything'), true)
  assert.equal(repoAllowed(cfg, 'other/exact'), true)
  assert.equal(repoAllowed(cfg, 'other/other'), false)
  assert.equal(repoAllowed(cfg, 'https://github.com/me/anything.git'), true)

  const open = normalizeConfig({ workspaceRoot: process.cwd() }, process.cwd())
  assert.equal(repoAllowed(open, 'any/repo'), true)

  const all = normalizeConfig({ allowRepos: ['*'], workspaceRoot: process.cwd() }, process.cwd())
  assert.equal(repoAllowed(all, 'any/repo'), true)

  const suffix = normalizeConfig({ allowRepos: ['*/harness'], workspaceRoot: process.cwd() }, process.cwd())
  assert.equal(repoAllowed(suffix, 'deepseek-ai/harness'), true)
  assert.equal(repoAllowed(suffix, 'deepseek-ai/other'), false)
})

await runner.test('回归 D1/D11：库名相同但 owner 不同不会再撞进同一目录', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    // 白名单同时允许两个 owner，但目录必须彼此独立。
    plugin.apply(ctx, {
      workspaceRoot: context.workspace, allowRepos: ['127.0.0.1/*', 'other/*'],
      allowNonGithubRemotes: true,
    })

    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    assert.equal(cloned.ok, true)
    assert.equal(path.basename(cloned.path), upstream.dirName, '目录名应包含 owner，避免同名库相撞')
    assert.equal(upstream.dirName, `${upstream.slug.split('/')[0]}__${upstream.slug.split('/')[1]}`)

    const status = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    assert.equal(status.origin, upstream.repo, 'status 应报告真实的 origin')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('回归 D1：本地目录 origin 与请求仓库不一致时，clone/push/pull 都拒绝', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: ['127.0.0.1/*', 'bob/*'],
      allowPush: true,
      // 本条测试针对 slug 不一致；主机校验由下一条回归测试单独覆盖。
      allowNonGithubRemotes: true,
    })

    const { runGit, repoDirName } = await import('../src/git.js')
    const otherRepo = 'bob/origin'
    const otherDir = path.join(context.workspace, repoDirName(otherRepo))

    // 场景一：目录被「另一个仓库」的内容占住（目录名相同、origin 不同）。
    const seeded = await runGit(['clone', upstream.repo, otherDir])
    assert.equal(seeded.ok, true, `预置目录失败：${seeded.stderr}`)
    await expectReject(
      () => call(tools, 'gh_repo', { repo: otherRepo, action: 'clone' }),
      /origin 是|不一致/,
    )

    // 场景二：origin 被换成另一个仓库 → 推送/拉取必须拒绝。
    // 先用真实可达的地址克隆（否则会去 clone github.com/bob/origin，这里没有网络），
    // 再把 origin 改成一个不同的地址，模拟「目录内容与请求的仓库不一致」。
    await runGit(['remote', 'set-url', 'origin', `${upstream.repo}-other`], { cwd: otherDir })
    await expectReject(() => call(tools, 'gh_push', { repo: otherRepo }), /origin 是|不一致/)
    await expectReject(() => call(tools, 'gh_pull', { repo: otherRepo }), /origin 是|不一致/)
    await expectReject(
      () => call(tools, 'gh_commit', { repo: otherRepo, message: 'x', push: true }),
      /origin 是|不一致|暂存区为空/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('回归 D2：gh_api 按 endpoint 而不是 args.repo 授权', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async (url, init) => {
    sent.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify({ ok: true }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowApiWrite: true, allowRepos: ['me/allowed'] })

    // 旧实现：repo 填白名单内、endpoint 指向别人 → 会真的打到别人的仓库。
    // 现在有两道闸：先拒绝 repo 与 endpoint 不一致，再独立校验 endpoint 指向的仓库。
    await expectReject(
      () => call(tools, 'gh_api', {
        endpoint: '/repos/victim/secret-repo/issues', method: 'POST', repo: 'me/allowed', body: '{"title":"x"}',
      }),
      /不一致/,
    )
    assert.equal(sent.length, 0, '被拒绝的请求绝不能发出去')

    // 只填 endpoint（不带 repo）时，白名单按 endpoint 判定。
    await expectReject(
      () => call(tools, 'gh_api', {
        endpoint: '/repos/victim/secret-repo/issues', method: 'POST', body: '{"title":"x"}',
      }),
      /allowRepos/,
    )
    assert.equal(sent.length, 0, '被拒绝的请求绝不能发出去')

    // 合法请求仍然走得通。
    const ok = await call(tools, 'gh_api', {
      endpoint: '/repos/me/allowed/issues', method: 'POST', repo: 'me/allowed', body: '{"title":"x"}',
    })
    assert.equal(ok.status, 201)
    assert.match(sent[0].url, /\/repos\/me\/allowed\/issues$/)
  })
})

await runner.test('回归 D3：没有 repo 参数时，只读调用也受 allowRepos 约束', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['me/allowed'] })

    await expectReject(() => call(tools, 'gh_api', { endpoint: '/repos/victim/secret/issues' }), /allowRepos/)
    assert.equal(sent.length, 0)

    const ok = await call(tools, 'gh_api', { endpoint: '/repos/me/allowed/issues' })
    assert.equal(ok.status, 200)
    assert.equal(sent.length, 1)

    // 显式放开只读限制后，白名单外的读才被允许。
    const permissive = fakeContext()
    plugin.apply(permissive.ctx, {
      workspaceRoot: process.cwd(), allowRepos: ['me/allowed'], allowApiReadOutsideAllowlist: true,
    })
    const read = await call(permissive.tools, 'gh_api', { endpoint: '/repos/victim/secret/issues' })
    assert.equal(read.status, 200)
  })
})

await runner.test('回归 D5：gh_repo action=create 需要 allowApiWrite 且过白名单', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async (url, init) => {
    sent.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify({ full_name: 'someorg/newthing' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowApiWrite: false, allowRepos: ['only/this'] })
    await expectReject(
      () => call(tools, 'gh_repo', { repo: 'someorg/x', action: 'create', name: 'newthing', owner: 'someorg' }),
      /allowApiWrite/,
    )
    assert.equal(sent.length, 0, '未开启 allowApiWrite 时不得发出创建请求')
  })

  const allowed = fakeContext()
  await withFakeFetch(async (url, init) => {
    sent.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify({ full_name: 'someorg/newthing', html_url: 'https://github.com/someorg/newthing' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })
  }, async () => {
    plugin.apply(allowed.ctx, { workspaceRoot: process.cwd(), allowApiWrite: true, allowRepos: ['only/this'] })
    await expectReject(
      () => call(allowed.tools, 'gh_repo', { repo: 'someorg/x', action: 'create', name: 'newthing', owner: 'someorg' }),
      /allowRepos/,
    )
    await expectReject(
      () => call(allowed.tools, 'gh_repo', { repo: 'someorg/x', action: 'create', name: '../evil', owner: 'someorg' }),
      /非法/,
    )
    assert.equal(sent.length, 0)
  })
})

await runner.test('回归 D4：allowRepos 拒绝完整 URL 规则，也拒绝非法形式', async () => {
  const plugin = await loadPlugin()
  const { ctx } = fakeContext()
  for (const bad of ['https://github.com/a/b', 'http://127.0.0.1:8080/a/b.git', 'a', 'a/b/c']) {
    assert.throws(
      () => plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: [bad] }),
      /owner\/repo|不接受完整 URL/,
      `规则 "${bad}" 应被拒绝`,
    )
  }
  // 合法形式不应抛错。
  for (const good of ['owner/repo', 'owner/*', '*/repo', '*', 'owner/repo.git']) {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: [good] })
  }
})

await runner.test('回归 D7：GH_TOKEN 回退真的生效', async () => {
  const { resolveToken } = await import('../src/auth.js')
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN }
  try {
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'gh-token-only'
    const resolved = await resolveToken({
      credentials: undefined, tokenRef: 'GITHUB_TOKEN', tokenEnv: 'GITHUB_TOKEN', dotenv: false,
    })
    assert.equal(resolved.token, 'gh-token-only')
    assert.equal(resolved.source, 'env:GH_TOKEN')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

await runner.test('回归 D8：仓库损坏时 status/log/branches 报错而不是假装成功', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['broken/repo'], allowPush: false })

  const { mkdir } = await import('node:fs/promises')
  const { repoDirName } = await import('../src/git.js')
  const dir = path.join(context.workspace, repoDirName('broken/repo'))
  await mkdir(path.join(dir, '.git'), { recursive: true })

  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'status' }), /git status 失败/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'log' }), /git log 失败/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'branches' }), /git branch 失败/)
})

await runner.test('回归 D9/D10：truncated 语义正确、log limit 被夹到合法范围', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true })
    await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    const whole = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt' })
    assert.equal(whole.truncated, false, '整份读完不该标记为截断')
    assert.equal(whole.from, 1)
    assert.equal(whole.to, whole.totalLines)

    const tail = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt', startLine: 2 })
    assert.equal(tail.truncated, true, '从中间开始读属于截断')
    assert.equal(tail.from, 2)

    const clamped = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 0 })
    assert.equal(clamped.limit, 1, 'limit 应被夹到 ≥1')
    assert.equal(clamped.count, 1)
    const big = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 9999 })
    assert.equal(big.limit, 200, 'limit 应被夹到 ≤200')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('回归 D3/D2：pushurl 重定向与不可信主机会被拒绝', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    // 注意：这里**不**开 allowNonGithubRemotes，主机校验生效。
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['127.0.0.1/*'], allowPush: true })

    const { runGit, repoDirName } = await import('../src/git.js')
    const dir = path.join(context.workspace, repoDirName(upstream.slug))

    // 场景一：远端主机不受信任 → clone 就被拒，凭据不会被发出去。
    await expectReject(
      () => call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' }),
      /远端主机/,
    )

    // 场景二：手工放一个克隆（origin 指向不可信主机）→ 推送被拒。
    const seeded = await runGit(['clone', upstream.repo, dir])
    assert.equal(seeded.ok, true, seeded.stderr)
    await expectReject(() => call(tools, 'gh_push', { repo: upstream.slug }), /远端主机/)

    // 场景三（D3 核心）：fetch URL 是可信的，但 pushurl 被改写 → 必须按 pushurl 拒绝。
    const trusted = await runGit(['remote', 'set-url', 'origin', 'https://github.com/127.0.0.1/origin.git'], { cwd: dir })
    assert.equal(trusted.ok, true, trusted.stderr)
    const poisoned = await runGit(
      ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:9/evil/origin.git'],
      { cwd: dir },
    )
    assert.equal(poisoned.ok, true, poisoned.stderr)

    await expectReject(() => call(tools, 'gh_push', { repo: upstream.slug }), /推送地址|远端主机/)
    await expectReject(
      () => call(tools, 'gh_commit', { repo: upstream.slug, message: 'x', push: true }),
      /推送地址|远端主机|暂存区为空/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('回归：gh_file 不得写入 .git 内部（config / hooks）', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true,
    })
    await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: '.git/config', content: 'x', overwrite: true }),
      /\.git 目录内部/,
    )
    await expectReject(
      () => call(tools, 'gh_file', {
        repo: upstream.repo, action: 'edit', path: '.git/config',
        oldText: '[core]', newText: '[core]\n\tbare = true',
      }),
      /\.git 目录内部/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: '.git/hooks/pre-commit', content: '#!/bin/sh\n', overwrite: true }),
      /\.git 目录内部/,
    )
    // 读取仍然允许：排查仓库配置时有用。
    const read = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: '.git/config' })
    assert.equal(read.ok, true, '读取 .git/config 应被允许')
    assert.match(read.content, /\[core\]/)
  } finally {
    await upstream.http.close()
  }
})

await runner.test('回归 D1：endpoint 里的 .. 不能绕过白名单', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'] })

    // 规范化后 target 是 secret/repo，必须被白名单拒绝。
    await expectReject(
      () => call(tools, 'gh_api', { endpoint: '/repos/allowed/repo/../../secret/repo/issues' }),
      /allowRepos/,
    )
    assert.equal(sent.length, 0, '被拒绝的请求绝不能发出去')

    // 合法路径仍然可用。
    const ok = await call(tools, 'gh_api', { endpoint: '/repos/allowed/repo/issues' })
    assert.equal(ok.status, 200)
    assert.equal(sent.length, 1)
  })
})

await runner.test('回归 D4：白名单生效时，无法确定仓库的仓库级 endpoint 被拒绝', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'] })

    for (const endpoint of ['/search/code?q=secret', '/user/repos', '/users/someone/repos', '/orgs/someone/repos']) {
      await expectReject(() => call(tools, 'gh_api', { endpoint }), /无法从|allowRepos/)
    }
    assert.equal(sent.length, 0, '被拒绝的请求绝不能发出去')

    // 账号/元信息类端点不属于仓库内容，仍然放行。
    const who = await call(tools, 'gh_api', { endpoint: '/user' })
    assert.equal(who.status, 200)
    assert.equal(sent.length, 1)

    // 显式放开后，仓库级只读端点也允许。
    const permissive = fakeContext()
    plugin.apply(permissive.ctx, {
      workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'], allowApiReadOutsideAllowlist: true,
    })
    const search = await call(permissive.tools, 'gh_api', { endpoint: '/search/code?q=x' })
    assert.equal(search.status, 200)
  })
})

await runner.test('回归 D5：白名单生效时 create 必须显式给 owner', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowApiWrite: true, allowRepos: ['me/*'] })
    await expectReject(
      () => call(tools, 'gh_repo', { repo: 'me/x', action: 'create', name: 'newthing' }),
      /必须显式给出 owner/,
    )
    assert.equal(sent.length, 0)
  })
})

runner.finish()
