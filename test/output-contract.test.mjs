/**
 * 用「宿主的 output 校验规则」逐个检查每个工具在所有可达分支上的返回值。
 *
 * 宿主的规则（dsh-util-values 的 isJsonValue）：值必须能无损通过 JSON 往返——
 * 出现 undefined / 函数 / Symbol / 非有限数字 / 非普通对象（class 实例）就算失败，
 * 整次工具调用会被判为 `value is not lossless JSON`。
 *
 * 插件最初就是在这里翻车：`gh_config action=status` 在没配 token 时返回了
 * `{ credentials_ref: undefined, identity: undefined }`，宿主直接报错。
 *
 * 运行：node test/output-contract.test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import {
  createRunner,
  fakeContext,
  loadPlugin,
  makeUpstream,
  call,
  withFakeFetch,
} from './harness.mjs'

const runner = createRunner('output-contract.test.mjs')

/** 等价于宿主对 output 值的无损 JSON 判定；返回违规列表。 */
function losslessProblems(value, pathLabel = 'output', seen = new Set()) {
  if (value === null) return []
  const type = typeof value
  if (type === 'string' || type === 'boolean') return []
  if (type === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? [] : [`${pathLabel}: 非有限数字或 -0`]
  }
  if (type === 'undefined') return [`${pathLabel}: undefined（JSON.stringify 会丢掉它）`]
  if (type === 'function') return [`${pathLabel}: function`]
  if (type === 'symbol' || type === 'bigint') return [`${pathLabel}: ${type}`]
  if (type !== 'object') return [`${pathLabel}: 未知类型 ${type}`]

  if (seen.has(value)) return [`${pathLabel}: 循环引用`]
  seen.add(value)
  /** @type {string[]} */
  const problems = []
  if (Array.isArray(value)) {
    // 数组必须稠密且没有额外属性：宿主用 Reflect.ownKeys 判定。
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) problems.push(`${pathLabel}: 数组有额外属性或空洞`)
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) problems.push(`${pathLabel}[${index}]: 空洞`)
    }
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${pathLabel}[${index}]`, seen)))
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      problems.push(`${pathLabel}: 非普通对象（原型 ${proto?.constructor?.name ?? 'unknown'}）`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') problems.push(`${pathLabel}: 非字符串键 ${String(key)}`)
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) problems.push(`${pathLabel}.${String(key)}: 不可枚举`)
    }
    for (const [key, item] of Object.entries(value)) {
      problems.push(...losslessProblems(item, `${pathLabel}.${key}`, seen))
    }
  }
  seen.delete(value)
  return problems
}

/** 调用工具并断言返回值满足宿主的无损 JSON 契约。 */
async function callChecked(tools, name, args, exec, context = {}) {
  const value = await call(tools, name, args, exec)
  const problems = losslessProblems(value, `${name} ${JSON.stringify(args)}`)
  assert.deepEqual(problems, [], `${context.label ?? name} 的返回值不是无损 JSON：\n  ${problems.join('\n  ')}`)
  const roundTrip = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip, value, `${context.label ?? name} 的返回值经 JSON 往返后发生变化`)
  return value
}

await runner.test('gh_config status：未配置 token / 有凭据服务 / 已配置三种形态都无损', async () => {
  const plugin = await loadPlugin()

  // 形态 1：什么都没有（就是这里最初返回了 undefined 键）。
  const bare = fakeContext()
  plugin.apply(bare.ctx, { workspaceRoot: process.cwd() })
  const none = await callChecked(bare.tools, 'gh_config', { action: 'status' })
  assert.equal(none.configured, false)
  assert.equal('identity' in none, false, '没有 token 时不应出现 identity 键')

  // 形态 2：有凭据服务但未配置（describe 返回 configured:false / source:undefined）。
  const store = new Map()
  const credentials = {
    async resolve(ref) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'file' } },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
    async describe(ref) { return { configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true } },
  }
  const withService = fakeContext({ credentials })
  plugin.apply(withService.ctx, { workspaceRoot: process.cwd() })
  await callChecked(withService.tools, 'gh_config', { action: 'status' }, undefined, { label: 'gh_config(服务已挂载,未配置)' })

  // 形态 3：已配置 + 远端返回缺字段（没有 x-oauth-scopes）。
  await withFakeFetch(async () => new Response(JSON.stringify({ login: 'octocat' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }), async () => {
    await callChecked(withService.tools, 'gh_config', { action: 'set', token: 'ghp_x' })
    const configured = await callChecked(withService.tools, 'gh_config', { action: 'status' }, undefined, {
      label: 'gh_config(已配置,响应缺 scopes)',
    })
    assert.equal(configured.identity.login, 'octocat')
    assert.equal('scopes' in configured.identity, false)
    await callChecked(withService.tools, 'gh_config', { action: 'unset' })
  })
})

await runner.test('gh_repo status：origin 缺失（没有 remote）时也要无损', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['local/repo'], allowNonGithubRemotes: true })

  const { runGit, repoDirName } = await import('../src/git.js')
  const dir = path.join(context.workspace, repoDirName('local/repo'))
  assert.equal((await runGit(['init', '--initial-branch=main', dir])).ok, true)
  await runGit(['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir })

  // 没有 origin：origin 字段必须是缺失而不是 undefined。
  const status = await callChecked(tools, 'gh_repo', { repo: 'local/repo', action: 'status' })
  assert.equal(status.clean, true)
  assert.equal('origin' in status, false, '没有 remote 时不应出现 origin 键')

  // 空仓库（还没有任何提交）：head 也应为缺失。
  const emptyDir = path.join(context.workspace, repoDirName('local/empty'))
  assert.equal((await runGit(['init', '--initial-branch=main', emptyDir])).ok, true)
  const empty = await callChecked(tools, 'gh_repo', { repo: 'local/empty', action: 'status' })
  assert.equal('head' in empty, false, '空仓库不应出现 head 键')
})

await runner.test('gh_file list：目录项没有 size 时不能留 undefined', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true,
    })
    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(cloned.path, 'somedir'), { recursive: true })

    const listed = await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'list' })
    const dirEntry = listed.entries.find(entry => entry.name === 'somedir')
    assert.ok(dirEntry, '应列出 somedir')
    assert.equal(dirEntry.type, 'dir')
    assert.equal('size' in dirEntry, false, '目录不应出现 size 键')
    const fileEntry = listed.entries.find(entry => entry.name === 'src.txt')
    assert.equal(typeof fileEntry.size, 'number')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('全部工具的常规路径返回值都是无损 JSON', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: [upstream.allowRule],
      allowPush: true,
      allowNonGithubRemotes: true,
      gitAuthorName: 'dsh-test',
      gitAuthorEmail: 'dsh@example.com',
    })

    // gh_repo 的各 action
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'diff' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'log' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'branches' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' }, undefined, { label: 'gh_repo fetch' })

    // gh_file 的各 action
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt' })
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'list' })
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'n.txt', content: 'x\n' })
    await callChecked(tools, 'gh_file', {
      repo: upstream.repo, action: 'edit', path: 'n.txt', oldText: 'x\n', newText: 'y\n',
    })

    // gh_commit / gh_push
    await callChecked(tools, 'gh_commit', { repo: upstream.repo, message: 'feat: 无损测试' })
    await callChecked(tools, 'gh_push', { repo: upstream.repo })
    await callChecked(tools, 'gh_pull', { repo: upstream.repo })

    // gh_api（只读，走假 fetch）
    const apiCtx = fakeContext()
    plugin.apply(apiCtx.ctx, { workspaceRoot: process.cwd(), allowRepos: ['me/repo'] })
    await withFakeFetch(async (url, init) => new Response(
      init?.method === 'DELETE' ? '' : JSON.stringify({ full_name: 'me/repo', items: [1, 2] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '10' } },
    ), async () => {
      await callChecked(apiCtx.tools, 'gh_api', { endpoint: '/repos/me/repo' })
      await callChecked(apiCtx.tools, 'gh_api', { endpoint: '/repos/me/repo/issues', query: '{"state":"open"}' })
    })

    // gh_config
    await callChecked(tools, 'gh_config', { action: 'status' })
  } finally {
    await upstream.http.close()
  }
})

await runner.test('失败路径抛的是 Error 而不是非法返回值', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['a/b'] })

  // 错误信息里不能带 undefined 字面量之外的结构问题：抛 Error 即可。
  let failed
  try {
    await call(tools, 'gh_repo', { repo: 'a/b', action: 'nope' })
  } catch (error) {
    failed = error
  }
  assert.ok(failed instanceof Error)
  assert.ok(!String(failed.message).includes('undefined'), `错误信息里不应出现 undefined：${failed.message}`)

  let failed2
  try {
    await call(tools, 'gh_config', { action: 'set' })
  } catch (error) {
    failed2 = error
  }
  assert.ok(failed2 instanceof Error)
  assert.ok(!String(failed2.message).includes('undefined'), `错误信息里不应出现 undefined：${failed2.message}`)
})

runner.finish()
