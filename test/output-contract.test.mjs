/**
 * Check every tool's return value on every reachable branch against "the host's output validation rules".
 *
 * The host's rule (isJsonValue in dsh-util-values): a value must survive a JSON round trip losslessly —
 * an undefined / function / Symbol / non-finite number / non-plain object (a class instance) counts as
 * a failure, and the whole tool call is judged `value is not lossless JSON`.
 *
 * This is exactly where the plugin first tripped over: `gh_config action=status` returned
 * `{ credentials_ref: undefined, identity: undefined }` when no token was configured, and the host reported an error.
 *
 * Run: node test/output-contract.test.mjs
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

/** Equivalent to the host's lossless-JSON judgement of an output value; returns the list of violations. */
function losslessProblems(value, pathLabel = 'output', seen = new Set()) {
  if (value === null) return []
  const type = typeof value
  if (type === 'string' || type === 'boolean') return []
  if (type === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? [] : [`${pathLabel}: non-finite number or -0`]
  }
  if (type === 'undefined') return [`${pathLabel}: undefined (JSON.stringify drops it)`]
  if (type === 'function') return [`${pathLabel}: function`]
  if (type === 'symbol' || type === 'bigint') return [`${pathLabel}: ${type}`]
  if (type !== 'object') return [`${pathLabel}: unknown type ${type}`]

  if (seen.has(value)) return [`${pathLabel}: circular reference`]
  seen.add(value)
  /** @type {string[]} */
  const problems = []
  if (Array.isArray(value)) {
    // An array must be dense and carry no extra properties: the host judges with Reflect.ownKeys.
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) problems.push(`${pathLabel}: array has extra properties or holes`)
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) problems.push(`${pathLabel}[${index}]: hole`)
    }
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${pathLabel}[${index}]`, seen)))
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      problems.push(`${pathLabel}: non-plain object (prototype ${proto?.constructor?.name ?? 'unknown'})`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') problems.push(`${pathLabel}: non-string key ${String(key)}`)
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) problems.push(`${pathLabel}.${String(key)}: not enumerable`)
    }
    for (const [key, item] of Object.entries(value)) {
      problems.push(...losslessProblems(item, `${pathLabel}.${key}`, seen))
    }
  }
  seen.delete(value)
  return problems
}

/** Call a tool and assert its return value satisfies the host's lossless-JSON contract. */
async function callChecked(tools, name, args, exec, context = {}) {
  const value = await call(tools, name, args, exec)
  const problems = losslessProblems(value, `${name} ${JSON.stringify(args)}`)
  assert.deepEqual(problems, [], `${context.label ?? name} did not return lossless JSON:\n  ${problems.join('\n  ')}`)
  const roundTrip = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip, value, `${context.label ?? name}: the return value changed after a JSON round trip`)
  return value
}

await runner.test('gh_config status: all three shapes (no token / credentials service present / configured) are lossless', async () => {
  const plugin = await loadPlugin()

  // Shape 1: nothing at all (this is where an undefined key was first returned).
  const bare = fakeContext()
  plugin.apply(bare.ctx, { workspaceRoot: process.cwd() })
  const none = await callChecked(bare.tools, 'gh_config', { action: 'status' })
  assert.equal(none.configured, false)
  assert.equal('identity' in none, false, 'without a token there must be no identity key')

  // Shape 2: the credentials service is present but nothing is configured (describe returns configured:false / source:undefined).
  const store = new Map()
  const credentials = {
    async resolve(ref) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'file' } },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
    async describe(ref) { return { configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true } },
  }
  const withService = fakeContext({ credentials })
  plugin.apply(withService.ctx, { workspaceRoot: process.cwd() })
  await callChecked(withService.tools, 'gh_config', { action: 'status' }, undefined, { label: 'gh_config(service mounted, not configured)' })

  // Shape 3: configured + the remote response misses a field (no x-oauth-scopes).
  await withFakeFetch(async () => new Response(JSON.stringify({ login: 'octocat' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }), async () => {
    await callChecked(withService.tools, 'gh_config', { action: 'set', token: 'ghp_x' })
    const configured = await callChecked(withService.tools, 'gh_config', { action: 'status' }, undefined, {
      label: 'gh_config(configured, response misses scopes)',
    })
    assert.equal(configured.identity.login, 'octocat')
    assert.equal('scopes' in configured.identity, false)
    await callChecked(withService.tools, 'gh_config', { action: 'unset' })
  })
})

await runner.test('gh_repo status: still lossless when origin is missing (no remote)', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['local/repo'], allowNonGithubRemotes: true })

  const { runGit, repoDirName } = await import('../src/git.js')
  const dir = path.join(context.workspace, repoDirName('local/repo'))
  assert.equal((await runGit(['init', '--initial-branch=main', dir])).ok, true)
  await runGit(['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir })

  // No origin: the origin field must be missing rather than undefined.
  const status = await callChecked(tools, 'gh_repo', { repo: 'local/repo', action: 'status' })
  assert.equal(status.clean, true)
  assert.equal('origin' in status, false, 'without a remote there must be no origin key')

  // An empty repository (no commits yet): head should be missing too.
  const emptyDir = path.join(context.workspace, repoDirName('local/empty'))
  assert.equal((await runGit(['init', '--initial-branch=main', emptyDir])).ok, true)
  const empty = await callChecked(tools, 'gh_repo', { repo: 'local/empty', action: 'status' })
  assert.equal('head' in empty, false, 'an empty repository must not expose a head key')
})

await runner.test('gh_file list: a directory entry without a size must not leave an undefined behind', async context => {
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
    assert.ok(dirEntry, 'somedir should be listed')
    assert.equal(dirEntry.type, 'dir')
    assert.equal('size' in dirEntry, false, 'a directory must not expose a size key')
    const fileEntry = listed.entries.find(entry => entry.name === 'src.txt')
    assert.equal(typeof fileEntry.size, 'number')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('every tool returns lossless JSON on its normal path', async context => {
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

    // Every gh_repo action
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'diff' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'log' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'branches' })
    await callChecked(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' }, undefined, { label: 'gh_repo fetch' })

    // Every gh_file action
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt' })
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'list' })
    await callChecked(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'n.txt', content: 'x\n' })
    await callChecked(tools, 'gh_file', {
      repo: upstream.repo, action: 'edit', path: 'n.txt', oldText: 'x\n', newText: 'y\n',
    })

    // gh_commit / gh_push
    await callChecked(tools, 'gh_commit', { repo: upstream.repo, message: 'feat: lossless test' })
    await callChecked(tools, 'gh_push', { repo: upstream.repo })
    await callChecked(tools, 'gh_pull', { repo: upstream.repo })

    // gh_api (read-only, through a fake fetch)
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

await runner.test('failure paths throw an Error instead of returning an invalid value', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['a/b'] })

  // Beyond the undefined literal, the error message must not leak structural problems: throwing an Error is enough.
  let failed
  try {
    await call(tools, 'gh_repo', { repo: 'a/b', action: 'nope' })
  } catch (error) {
    failed = error
  }
  assert.ok(failed instanceof Error)
  assert.ok(!String(failed.message).includes('undefined'), `the error message must not contain undefined: ${failed.message}`)

  let failed2
  try {
    await call(tools, 'gh_config', { action: 'set' })
  } catch (error) {
    failed2 = error
  }
  assert.ok(failed2 instanceof Error)
  assert.ok(!String(failed2.message).includes('undefined'), `the error message must not contain undefined: ${failed2.message}`)
})

runner.finish()
