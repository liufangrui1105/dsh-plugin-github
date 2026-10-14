/**
 * dsh-plugin-github — plugin end-to-end tests
 *
 * Call the real apply() with a fake ctx, then run the registered tool definitions one by one against the
 * real implementation: real git subprocesses, the real filesystem and real smart HTTP (`git http-backend`),
 * with no network dependency.
 *
 * Run: node test/plugin.test.mjs
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
 * Assert that an operation is definitely rejected.
 *
 * Every operation wraps `await` in an explicit try/catch: in this environment (Node 24.19 + a custom
 * harness) splitting "the call" and "handling the rejection" into two expressions can let the rejection
 * escape as a process-level unhandled rejection before `await p.then(onOk, onErr)`, which tears the test
 * process down. Wrapping await in try/catch is stable for both shapes (a synchronous throw and a promise rejection).
 * @param {() => unknown} operation
 * @param {RegExp} pattern
 * @param {string} [label]
 */
async function expectReject(operation, pattern, label) {
  let failed
  try {
    const value = await operation()
    throw new Error(`${label ?? 'expectReject'}: expected a rejection but the call succeeded: ${JSON.stringify(value)?.slice(0, 200)}`)
  } catch (error) {
    if (error instanceof Error && String(error.message).includes('expected a rejection')) throw error
    failed = error
  }
  const message = failed instanceof Error ? failed.message : String(failed)
  if (!pattern.test(message)) {
    throw new Error(`${label ?? 'expectReject'}: the error message does not match ${pattern}, actual: ${message}`)
  }
  return failed
}

const runner = createRunner('plugin.test.mjs')

const EXPECTED_TOOLS = ['gh_account', 'gh_api', 'gh_commit', 'gh_config', 'gh_file', 'gh_pull', 'gh_push', 'gh_repo']

await runner.test('apply registers every tool, each declaring parameters + output.schema + output.render', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd() })

  assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS)
  for (const [name, definition] of tools) {
    assert.equal(definition.parameters.type, 'object', `${name}.parameters must have an object root`)
    assert.equal(typeof definition.parameters.properties, 'object', `${name}.parameters needs properties`)
    // The real dsh-tools asserts that output.schema belongs to the supported subset; an annotation schema allows annotation keywords only.
    const keys = Object.keys(definition.output.schema)
    assert.ok(
      keys.every(key => ['description', 'title', 'default', 'examples'].includes(key)),
      `${name}: output.schema should be an annotation schema, actual keys: ${keys.join(', ')}`,
    )
    // Required parameters must be listed in the JSON Schema required array.
    const declaredRequired = definition.parameters.required ?? []
    for (const key of declaredRequired) {
      assert.ok(definition.parameters.properties[key], `${name}: required "${key}" is not declared in properties`)
    }
  }
  assert.deepEqual(tools.get('gh_repo').parameters.required, ['repo', 'action'])
  assert.deepEqual(tools.get('gh_commit').parameters.required, ['repo', 'message'])
})

await runner.test('an unknown config key warns without affecting registration', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools, logs } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd(), allowPushes: true })
  assert.equal(tools.size, EXPECTED_TOOLS.length)
  assert.ok(logs.some(([level, text]) => level === 'warn' && text.includes('allowPushes')))
})

await runner.test('clone → read a file → edit → status → diff → commit → push end to end', async context => {
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
    assert.equal(cloned.ok, true, `clone failed: ${cloned.error ?? ''}`)
    assert.equal(cloned.action, 'clone')
    assert.equal(cloned.head.subject, 'init')
    assert.equal(cloned.auth, 'anonymous')
    assert.equal(path.basename(cloned.path), upstream.dirName)

    const listed = await call(tools, 'gh_file', { repo: upstream.repo, action: 'list' })
    const names = listed.entries.map(entry => entry.name)
    assert.ok(names.includes('README.md') && names.includes('src.txt'), `the listing is missing files: ${names.join(', ')}`)
    assert.ok(!names.includes('.git'), '.git must not appear in the listing')

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
      repo: upstream.repo, message: 'fix: change one line', paths: ['src.txt'],
    })
    assert.equal(committed.ok, true)
    assert.equal(committed.pushed, false)
    assert.notEqual(committed.head.sha, cloned.head.sha)

    const log = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 5 })
    assert.equal(log.commits[0].subject, 'fix: change one line')
    assert.equal(log.commits[0].author, 'dsh-test')

    const branches = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'branches' })
    assert.ok(branches.branches.some(entry => entry.name === 'main' && entry.current))

    const pushed = await call(tools, 'gh_push', { repo: upstream.repo })
    assert.equal(pushed.ok, true, `push failed: ${pushed.error ?? ''}`)

    // The remote must really receive the commit: verify with another clone.
    const { runGit } = await import('../src/git.js')
    const fresh = path.join(root, 'fresh')
    const recloned = await runGit(['clone', upstream.repo, fresh])
    assert.equal(recloned.ok, true, `the second clone failed: ${recloned.stderr}`)
    const remoteLog = await runGit(['log', '--pretty=format:%s', '-n', '1'], { cwd: fresh })
    assert.equal(remoteLog.stdout.trim(), 'fix: change one line')

    const verify = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    assert.equal(verify.action, 'fetch', 'an existing clone must go through fetch instead of cloning again')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_commit { push: true } commits and pushes in one step', async context => {
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
    await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'new/note.md', content: '# new file\n' })
    const committed = await call(tools, 'gh_commit', {
      repo: upstream.repo, message: 'feat: add notes', push: true,
    })
    assert.equal(committed.pushed.ok, true, `push failed: ${committed.pushed.error ?? ''}`)
    assert.equal(committed.stagedFiles.length, 1)

    const { runGit } = await import('../src/git.js')
    const fresh = path.join(root, 'fresh')
    assert.equal((await runGit(['clone', upstream.repo, fresh])).ok, true)
    const subject = await runGit(['log', '--pretty=format:%s', '-n', '1'], { cwd: fresh })
    assert.equal(subject.stdout.trim(), 'feat: add notes')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_pull brings new remote commits back into the local clone', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true, allowPush: true })
    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    // Push a new commit to the remote from another developer's clone.
    const { runGit } = await import('../src/git.js')
    const other = path.join(root, 'other')
    assert.equal((await runGit(['clone', upstream.repo, other])).ok, true)
    const author = ['-c', 'user.name=other', '-c', 'user.email=other@example.com']
    await import('node:fs/promises').then(fs => fs.writeFile(path.join(other, 'remote.txt'), 'from the remote\n'))
    assert.equal((await runGit([...author, 'add', '.'], { cwd: other })).ok, true)
    assert.equal((await runGit([...author, 'commit', '-m', 'feat: remote addition'], { cwd: other })).ok, true)
    assert.equal((await runGit(['push', 'origin', 'main'], { cwd: other })).ok, true)

    const pulled = await call(tools, 'gh_pull', { repo: upstream.repo })
    assert.equal(pulled.ok, true, `pull failed: ${pulled.error ?? ''}`)
    assert.equal(pulled.changed, true)
    assert.equal(await readFile(path.join(cloned.path, 'remote.txt'), 'utf8'), 'from the remote\n')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('allowPush=false refuses pushes; a repository outside the allowlist refuses any write', async context => {
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

    // The commit still lands locally (the refusal only covers remote writes).
    const status = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    assert.equal(status.clean, true, 'the worktree should be clean after committing')

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

await runner.test('gh_file edit count validation, put overwrite protection and path-escape protection', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true })

    await expectReject(
      () => call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' }),
      /There is no local clone of|gh_repo \(action=clone/,
      'an uncloned repository should produce an actionable hint',
    )

    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'notes.txt', content: 'same\nsame\n' })
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'notes.txt', content: 'again\n' }),
      /overwrite/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: 'same\n', newText: 'x\n' }),
      /oldText appears 2 time/,
    )
    const replaced = await call(tools, 'gh_file', {
      repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: 'same\n', newText: 'x\n', count: 2,
    })
    assert.equal(replaced.replacements, 2)
    assert.equal(await readFile(path.join(cloned.path, 'notes.txt'), 'utf8'), 'x\nx\n')
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'edit', path: 'notes.txt', oldText: 'missing text', newText: 'y' }),
      /oldText was not found/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: '../../etc/passwd' }),
      /Path escapes the workspace/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('argument validation: missing required / wrong type / unknown action', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: process.cwd() })

  await expectReject(() => call(tools, 'gh_repo', { repo: 'a/b' }), /missing required parameter action/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'a/b', action: 'nope' }), /Unsupported action/)
  await expectReject(
    () => call(tools, 'gh_repo', { repo: 'a/b', action: 'clone', depth: 'deep' }),
    /depth must be a number/,
  )
  await expectReject(
    () => call(tools, 'gh_commit', { repo: 'a/b', message: 'm', paths: [1, 2] }),
    /every element of paths must be string/,
  )
  await expectReject(() => call(tools, 'gh_file', { repo: 'a/b', action: 'get' }), /requires the path parameter/)
  await expectReject(() => call(tools, 'gh_api', { endpoint: '/user', method: 'TRACE' }), /Unsupported method/)
  await expectReject(() => call(tools, 'gh_api', { endpoint: '/user/following/x', method: 'PUT' }), /allowApiWrite/)
  await expectReject(() => call(tools, 'gh_config', { action: 'set' }), /requires the token parameter/)
})

await runner.test('gh_config: with the credentials service available it writes / reads back / deletes, and the result never echoes the token', async () => {
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
    assert.ok(!JSON.stringify(set).includes('ghp_test_token_value'), 'the tool result must never echo the token')

    const after = await call(tools, 'gh_config', { action: 'status' })
    assert.equal(after.configured, true)
    assert.equal(after.identity.login, 'octocat')
    assert.equal(after.identity.scopes, 'repo')

    const unset = await call(tools, 'gh_config', { action: 'unset' })
    assert.equal(unset.ok, true)
    assert.equal(store.has('MY_GH_TOKEN'), false)
  })

  // Without the credentials service: set fails and suggests the environment-variable alternative.
  const plain = fakeContext()
  plugin.apply(plain.ctx, { workspaceRoot: process.cwd(), tokenRef: 'MY_GH_TOKEN' })
  await expectReject(
    () => call(plain.tools, 'gh_config', { action: 'set', token: 'x' }),
    /ctx\.credentials|environment variable/,
  )
})

await runner.test('gh_api: GET works, and writes are bound by both allowApiWrite and the allowlist', async () => {
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
      /cannot determine the target repository/,
    )
    await expectReject(() => call(tools, 'gh_api', { endpoint: '/user', query: 'not json' }), /is not valid JSON/)
    await expectReject(() => call(tools, 'gh_api', { endpoint: 'https://evil.example.com/user' }), /only api\.github\.com may be accessed/)
  })
})

await runner.test('auth: the fallback order credentials service → environment variable → .env', async () => {
  const { resolveToken, parseDotenv } = await import('../src/auth.js')

  assert.deepEqual(parseDotenv('A=1\n# comment\nexport B="two"\nC=\'\'\nbad line\n'), { A: '1', B: 'two' })

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

    // When the credentials service throws, fall back instead of failing the whole call.
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

await runner.test('auth.js does no direct printing (so a token cannot leak into a log)', async () => {
  const source = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8')
  assert.ok(!/console\.(log|error|warn|debug)/.test(source), 'auth.js must not print anything directly')
})

await runner.test('repos.js allowlist syntax: owner/repo, owner/*, */repo, *', async () => {
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

await runner.test('regression D1/D11: the same repository name under a different owner no longer collides into one directory', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    // The allowlist allows both owners, but the directories must stay independent.
    plugin.apply(ctx, {
      workspaceRoot: context.workspace, allowRepos: ['127.0.0.1/*', 'other/*'],
      allowNonGithubRemotes: true,
    })

    const cloned = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })
    assert.equal(cloned.ok, true)
    assert.equal(path.basename(cloned.path), upstream.dirName, 'the directory name should include the owner so identically named repositories do not collide')
    assert.equal(upstream.dirName, `${upstream.slug.split('/')[0]}__${upstream.slug.split('/')[1]}`)

    const status = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
    assert.equal(status.origin, upstream.repo, 'status should report the real origin')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('regression D1: when the local directory origin differs from the requested repository, clone/push/pull all refuse', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, {
      workspaceRoot: context.workspace,
      allowRepos: ['127.0.0.1/*', 'bob/*'],
      allowPush: true,
      // This test covers a slug mismatch; host validation is covered separately by the next regression test.
      allowNonGithubRemotes: true,
    })

    const { runGit, repoDirName } = await import('../src/git.js')
    const otherRepo = 'bob/origin'
    const otherDir = path.join(context.workspace, repoDirName(otherRepo))

    // Case 1: the directory is occupied by "another repository" (same directory name, different origin).
    const seeded = await runGit(['clone', upstream.repo, otherDir])
    assert.equal(seeded.ok, true, `seeding the directory failed: ${seeded.stderr}`)
    await expectReject(
      () => call(tools, 'gh_repo', { repo: otherRepo, action: 'clone' }),
      /Refusing the operation: the (?:origin|push target \S+) of local directory/,
    )

    // Case 2: the origin is swapped for another repository → push/pull must refuse.
    // Clone from a genuinely reachable address first (otherwise it would try to clone github.com/bob/origin,
    // and there is no network here), then rewrite the origin to simulate "the contents do not match the request".
    await runGit(['remote', 'set-url', 'origin', `${upstream.repo}-other`], { cwd: otherDir })
    await expectReject(() => call(tools, 'gh_push', { repo: otherRepo }), /Refusing the operation: the (?:origin|push target \S+) of local directory/)
    await expectReject(() => call(tools, 'gh_pull', { repo: otherRepo }), /Refusing the operation: the (?:origin|push target \S+) of local directory/)
    await expectReject(
      () => call(tools, 'gh_commit', { repo: otherRepo, message: 'x', push: true }),
      /Refusing the operation: the (?:origin|push target \S+) of local directory|staging area is empty/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('regression D2: gh_api authorizes by endpoint, not by args.repo', async () => {
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

    // The old implementation: repo inside the allowlist while the endpoint pointed at someone else →
    // it really hit the other repository. There are now two gates: first refuse a repo that disagrees
    // with the endpoint, then independently validate the repository the endpoint points at.
    await expectReject(
      () => call(tools, 'gh_api', {
        endpoint: '/repos/victim/secret-repo/issues', method: 'POST', repo: 'me/allowed', body: '{"title":"x"}',
      }),
      /do not match/,
    )
    assert.equal(sent.length, 0, 'a refused request must never be sent')

    // When only the endpoint is given (no repo), the allowlist is judged from the endpoint.
    await expectReject(
      () => call(tools, 'gh_api', {
        endpoint: '/repos/victim/secret-repo/issues', method: 'POST', body: '{"title":"x"}',
      }),
      /allowRepos/,
    )
    assert.equal(sent.length, 0, 'a refused request must never be sent')

    // A legitimate request still goes through.
    const ok = await call(tools, 'gh_api', {
      endpoint: '/repos/me/allowed/issues', method: 'POST', repo: 'me/allowed', body: '{"title":"x"}',
    })
    assert.equal(ok.status, 201)
    assert.match(sent[0].url, /\/repos\/me\/allowed\/issues$/)
  })
})

await runner.test('regression D3: without a repo argument, even read-only calls are bound by allowRepos', async () => {
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

    // Only after explicitly relaxing the read restriction is a read outside the allowlist allowed.
    const permissive = fakeContext()
    plugin.apply(permissive.ctx, {
      workspaceRoot: process.cwd(), allowRepos: ['me/allowed'], allowApiReadOutsideAllowlist: true,
    })
    const read = await call(permissive.tools, 'gh_api', { endpoint: '/repos/victim/secret/issues' })
    assert.equal(read.status, 200)
  })
})

await runner.test('regression D5: gh_repo action=create needs allowApiWrite and must pass the allowlist', async () => {
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
    assert.equal(sent.length, 0, 'with allowApiWrite off no create request may be sent')
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
      /is invalid/,
    )
    assert.equal(sent.length, 0)
  })
})

await runner.test('regression D4: allowRepos rejects full-URL rules and invalid forms', async () => {
  const plugin = await loadPlugin()
  const { ctx } = fakeContext()
  for (const bad of ['https://github.com/a/b', 'http://127.0.0.1:8080/a/b.git', 'a', 'a/b/c']) {
    assert.throws(
      () => plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: [bad] }),
      /not a valid owner\/repo form/,
      `rule "${bad}" should be rejected`,
    )
  }
  // Valid forms must not throw.
  for (const good of ['owner/repo', 'owner/*', '*/repo', '*', 'owner/repo.git']) {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: [good] })
  }
})

await runner.test('regression D7: the GH_TOKEN fallback really works', async () => {
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

await runner.test('regression D8: with a corrupt repository, status/log/branches error out instead of pretending to succeed', async context => {
  const root = await context.setup()
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['broken/repo'], allowPush: false })

  const { mkdir } = await import('node:fs/promises')
  const { repoDirName } = await import('../src/git.js')
  const dir = path.join(context.workspace, repoDirName('broken/repo'))
  await mkdir(path.join(dir, '.git'), { recursive: true })

  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'status' }), /git status failed/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'log' }), /git log failed/)
  await expectReject(() => call(tools, 'gh_repo', { repo: 'broken/repo', action: 'branches' }), /git branch failed/)
})

await runner.test('regression D9/D10: truncated semantics are correct and the log limit is clamped to a legal range', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: [upstream.allowRule],
      allowNonGithubRemotes: true })
    await call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' })

    const whole = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt' })
    assert.equal(whole.truncated, false, 'reading the whole file must not be flagged as truncated')
    assert.equal(whole.from, 1)
    assert.equal(whole.to, whole.totalLines)

    const tail = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: 'src.txt', startLine: 2 })
    assert.equal(tail.truncated, true, 'starting in the middle counts as truncated')
    assert.equal(tail.from, 2)

    const clamped = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 0 })
    assert.equal(clamped.limit, 1, 'limit should be clamped to >= 1')
    assert.equal(clamped.count, 1)
    const big = await call(tools, 'gh_repo', { repo: upstream.repo, action: 'log', limit: 9999 })
    assert.equal(big.limit, 200, 'limit should be clamped to <= 200')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('regression D3/D2: a pushurl redirect and an untrusted host are both refused', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const { ctx, tools } = fakeContext()
    // Note: allowNonGithubRemotes is **not** enabled here, so host validation is active.
    plugin.apply(ctx, { workspaceRoot: context.workspace, allowRepos: ['127.0.0.1/*'], allowPush: true })

    const { runGit, repoDirName } = await import('../src/git.js')
    const dir = path.join(context.workspace, repoDirName(upstream.slug))

    // Case 1: the remote host is untrusted → even clone is refused and credentials are never sent.
    await expectReject(
      () => call(tools, 'gh_repo', { repo: upstream.repo, action: 'clone' }),
      /Remote host/,
    )

    // Case 2: a manually placed clone (origin pointing at an untrusted host) → the push is refused.
    const seeded = await runGit(['clone', upstream.repo, dir])
    assert.equal(seeded.ok, true, seeded.stderr)
    await expectReject(() => call(tools, 'gh_push', { repo: upstream.slug }), /Remote host/)

    // Case 3 (the core of D3): the fetch URL is trusted but pushurl was rewritten → the pushurl must be what gets refused.
    const trusted = await runGit(['remote', 'set-url', 'origin', 'https://github.com/127.0.0.1/origin.git'], { cwd: dir })
    assert.equal(trusted.ok, true, trusted.stderr)
    const poisoned = await runGit(
      ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:9/evil/origin.git'],
      { cwd: dir },
    )
    assert.equal(poisoned.ok, true, poisoned.stderr)

    await expectReject(() => call(tools, 'gh_push', { repo: upstream.slug }), /push target|Remote host/)
    await expectReject(
      () => call(tools, 'gh_commit', { repo: upstream.slug, message: 'x', push: true }),
      /push target|Remote host|staging area is empty/,
    )
  } finally {
    await upstream.http.close()
  }
})

await runner.test('regression: gh_file must not write inside .git (config / hooks)', async context => {
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
      /inside of the \.git directory/,
    )
    await expectReject(
      () => call(tools, 'gh_file', {
        repo: upstream.repo, action: 'edit', path: '.git/config',
        oldText: '[core]', newText: '[core]\n\tbare = true',
      }),
      /inside of the \.git directory/,
    )
    await expectReject(
      () => call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: '.git/hooks/pre-commit', content: '#!/bin/sh\n', overwrite: true }),
      /inside of the \.git directory/,
    )
    // Reading is still allowed: useful when inspecting the repository config.
    const read = await call(tools, 'gh_file', { repo: upstream.repo, action: 'get', path: '.git/config' })
    assert.equal(read.ok, true, 'reading .git/config should be allowed')
    assert.match(read.content, /\[core\]/)
  } finally {
    await upstream.http.close()
  }
})

await runner.test('regression D1: .. inside an endpoint cannot bypass the allowlist', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'] })

    // After normalization the target is secret/repo, which the allowlist must refuse.
    await expectReject(
      () => call(tools, 'gh_api', { endpoint: '/repos/allowed/repo/../../secret/repo/issues' }),
      /allowRepos/,
    )
    assert.equal(sent.length, 0, 'a refused request must never be sent')

    // A legitimate path still works.
    const ok = await call(tools, 'gh_api', { endpoint: '/repos/allowed/repo/issues' })
    assert.equal(ok.status, 200)
    assert.equal(sent.length, 1)
  })
})

await runner.test('regression D4: with the allowlist active, repository-level endpoints whose repository cannot be determined are refused', async () => {
  const plugin = await loadPlugin()
  const { ctx, tools } = fakeContext()
  const sent = []

  await withFakeFetch(async url => {
    sent.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    plugin.apply(ctx, { workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'] })

    for (const endpoint of ['/search/code?q=secret', '/user/repos', '/users/someone/repos', '/orgs/someone/repos']) {
      await expectReject(() => call(tools, 'gh_api', { endpoint }), /Cannot tell the target repository|allowRepos/)
    }
    assert.equal(sent.length, 0, 'a refused request must never be sent')

    // Account/metadata endpoints are not repository content and are still allowed.
    const who = await call(tools, 'gh_api', { endpoint: '/user' })
    assert.equal(who.status, 200)
    assert.equal(sent.length, 1)

    // After explicitly relaxing the restriction, repository-level read-only endpoints are allowed too.
    const permissive = fakeContext()
    plugin.apply(permissive.ctx, {
      workspaceRoot: process.cwd(), allowRepos: ['allowed/repo'], allowApiReadOutsideAllowlist: true,
    })
    const search = await call(permissive.tools, 'gh_api', { endpoint: '/search/code?q=x' })
    assert.equal(search.status, 200)
  })
})

await runner.test('regression D5: with the allowlist active, create must pass owner explicitly', async () => {
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
      /must give owner explicitly/,
    )
    assert.equal(sent.length, 0)
  })
})

runner.finish()
