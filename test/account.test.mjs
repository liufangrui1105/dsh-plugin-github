/**
 * dsh-plugin-github — GitHub account-binding tests
 *
 * Covers: account storage (credentials-service backend / file backend), binding and switching
 * semantics, the automatic guidance on first use (including the user skipping and a non-interactive
 * environment), and the fact that the token never leaks.
 *
 * Run: node test/account.test.mjs
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

/** Build a fake GitHub /user response and return a different identity per token. */
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

/** Test store + manager directly (without the plugin) so backend details are easy to cover. */
async function managerWith(store, map) {
  const { fetchImpl } = identityFetcher(map)
  return {
    manager: createAccountManager({
      store,
      lookupIdentity: async token => {
        const response = await fetchImpl('/user', { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error('Token verification failed (fake lookupIdentity)')
        const body = await response.json()
        return { login: body.login, name: body.name, scopes: response.headers.get('x-oauth-scopes') }
      },
    }),
    fetchImpl,
  }
}

await runner.test('accountIdFor normalizes the login name and rejects invalid input', async () => {
  assert.equal(accountIdFor('Octocat'), 'octocat')
  assert.equal(accountIdFor('My-User_99'), 'my-user-99')
  assert.equal(accountIdFor('  A.B  '), 'a-b')
  assert.throws(() => accountIdFor(''), /Cannot derive a valid account id/)
  assert.throws(() => accountIdFor('---'), /Cannot derive a valid account id/)
})

await runner.test('file backend: bind → switch → remove, and the persisted content has no extra fields', async context => {
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
  assert.equal((await manager.active()).login, 'alice', 'binding should make it the current account automatically')

  const bob = await manager.bind('t2')
  assert.equal((await manager.active()).login, 'bob', 'binding again should switch over as well')

  // Switch back to alice (by login name, case-insensitive)
  await manager.use('ALICE')
  assert.equal((await manager.activeId()), 'alice')

  const listed = await manager.list()
  assert.equal(listed.length, 2)
  assert.equal(listed.filter(entry => entry.__active).length, 1)
  assert.equal(listed.find(entry => entry.__active).login, 'alice')

  const removed = await manager.remove('bob')
  assert.deepEqual(removed, { id: 'bob', wasActive: false })
  assert.equal((await manager.list()).length, 1)

  // The persisted file: it can be read back, and the token lives only in the plugin's own file
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.active, 'alice')
  assert.deepEqual(raw.accounts.map(entry => entry.id), ['alice'])
  assert.equal(raw.accounts[0].token, 't1')

  // A new instance should recover from disk
  const reopened = createFileStore(file)
  const reopenedManager = createAccountManager({
    store: reopened,
    lookupIdentity: async () => ({ login: 'alice' }),
  })
  assert.equal((await reopenedManager.active()).login, 'alice')
})

await runner.test('removing the current account clears the pointer instead of pointing at a missing account', async context => {
  const root = await context.setup()
  const store = createFileStore(path.join(root, 'a.json'))
  const { manager } = await managerWith(store, { t1: { login: 'solo' } })
  await manager.bind('t1')
  const removed = await manager.remove('solo')
  assert.equal(removed.wasActive, true)
  assert.equal(await manager.activeId(), undefined)
  assert.equal(await manager.active(), undefined)
})

await runner.test('credentials-service backend: record read/write, the active pointer, and a token that is not enumerable', async () => {
  /** A minimal in-memory credentials service (with modifyRecord / deleteRecord / listRecords). */
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

  // A record key must be `<scope>/<id>`, and the token is stored in the key field
  const record = records.get('github-repo/carol')
  assert.ok(record, 'should write github-repo/carol')
  assert.equal(record.kind, 'api-key')
  assert.equal(record.key, 't1')
  assert.equal(record.env.GITHUB_LOGIN, 'carol')
  assert.equal(records.get('github-repo/active').env.ACTIVE, 'carol')

  // Listing exposes only key and kind, never the token
  const entries = await provider.listRecords()
  assert.ok(!JSON.stringify(entries).includes('t1'), 'the enumeration result must never carry the token')

  await manager.remove('carol')
  assert.equal(records.has('github-repo/carol'), false)
})

await runner.test('selectStore: use the credentials service when present, otherwise fall back to the file', async context => {
  const root = await context.setup()
  const withService = selectStore({
    credentials: { listRecords: async () => [], readRecord: async () => undefined },
    dshHome: root,
  })
  assert.equal(withService.store.kind, 'credentials')

  const without = selectStore({ credentials: undefined, dshHome: root })
  assert.equal(without.store.kind, 'file')
  assert.match(without.reason, /credentials service is not mounted/)

  // A provider missing capabilities must fall back too (implementations differ across DSH combinations)
  const partial = selectStore({ credentials: { resolve: async () => undefined }, dshHome: root })
  assert.equal(partial.store.kind, 'file', 'it must fall back when listRecords/readRecord are missing')
})

await runner.test('edge cases of accountView / extractToken / isSkipAnswer', async () => {
  const view = accountView({ id: 'a', login: 'alice', token: 'SECRET', scopes: 'repo' }, 'a')
  assert.equal(view.login, 'alice')
  assert.equal(view.active, true)
  assert.ok(!JSON.stringify(view).includes('SECRET'), 'accountView must not carry a token')
  assert.equal('name' in view, false, 'unset fields must not appear')

  assert.equal(extractToken('ghp_' + 'a'.repeat(36)), 'ghp_' + 'a'.repeat(36))
  assert.equal(extractToken('  ghp_' + 'b'.repeat(40) + '  '), 'ghp_' + 'b'.repeat(40))
  assert.equal(extractToken('github_pat_' + 'c'.repeat(30)), 'github_pat_' + 'c'.repeat(30))
  assert.equal(extractToken('this is my token: ghp_' + 'd'.repeat(36) + ', please bind it'), 'ghp_' + 'd'.repeat(36))
  assert.equal(extractToken('just a short sentence'), undefined)
  assert.equal(extractToken(''), undefined)
  assert.equal(isSkipAnswer('Skip, do not bind now'), true)
  assert.equal(isSkipAnswer('Later'), true)
  assert.equal(isSkipAnswer('Skip'), true)
  assert.equal(isSkipAnswer('Use the existing environment variable'), false)
})

await runner.test('plugin: the full gh_account bind/list/use/remove/status flow', async context => {
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
    // Initially: nothing bound
    const initial = await call(tools, 'gh_account', { action: 'list' })
    assert.equal(initial.count, 0)
    assert.equal(initial.backend, 'file')
    assert.match(initial.hint, /bind/)

    // bind (pass the token directly)
    const bound = await call(tools, 'gh_account', { action: 'bind', token: 'tA' })
    assert.equal(bound.account.login, 'alice')
    assert.equal(bound.active, 'alice')
    assert.ok(!JSON.stringify(bound).includes('tA'), 'the return value must never echo the token')
    assert.equal(seen.at(-1).token, 'tA', 'the token must verify the identity before binding')

    // Bind another one → it switches automatically
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

    // use switches back to alice, and a later status confirms it uses the new account
    const used = await call(tools, 'gh_account', { action: 'use', login: 'alice' })
    assert.equal(used.account.login, 'alice')
    const status2 = await call(tools, 'gh_account', { action: 'status' })
    assert.equal(status2.identity.login, 'alice')
    assert.equal(seen.at(-1).token, 'tA', 'after switching, the alice token should be used')

    // remove
    const removed = await call(tools, 'gh_account', { action: 'remove', login: 'bob' })
    assert.equal(removed.removed, 'bob')
    assert.equal((await call(tools, 'gh_account', { action: 'list' })).count, 1)

    // An invalid token must not be stored
    await expectReject(() => call(tools, 'gh_account', { action: 'bind', token: 'bogus' }), /Token verification failed/)
    assert.equal((await call(tools, 'gh_account', { action: 'list' })).count, 1)

    // Unknown account
    await expectReject(() => call(tools, 'gh_account', { action: 'use', login: 'nobody' }), /Account ".*" not found/)
  })

  assert.equal(logs.filter(([level]) => level === 'error').length, 0)
})

await runner.test('a bound account takes priority over the environment variable (the bound account is the default)', async context => {
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
      assert.equal(status.identity.login, 'bound', 'the bound account should be preferred')
      assert.equal(seen.at(-1).token, 'tBound')
      // gh_api should use the bound account too
      await call(tools, 'gh_api', { endpoint: '/user' })
      assert.equal(seen.at(-1).token, 'tBound', 'gh_api must use the bound account token')
    })
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved
  }
})

await runner.test('the binding prompt appears automatically the first time credentials are needed, and the operation continues right after binding', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const asked = []
    const userQuestions = {
      async ask(request) {
        asked.push(request)
        // Simulate the user pasting a token into the input box
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
      // Step 1: clone. A public repository can be fetched anonymously, so no prompt appears here.
      const cloned = await call(
        tools,
        'gh_repo',
        { repo: upstream.repo, action: 'clone' },
        { agent: { fake: 'agent' } },
      )
      assert.equal(cloned.ok, true, `clone should succeed: ${cloned.error ?? ''}`)
      assert.equal(asked.length, 0, 'reading a public repository needs no credentials, so no prompt should appear')

      // Step 2: pushing needs write access → the binding prompt should appear, and the push should finish right after binding.
      const pushed = await call(
        tools,
        'gh_push',
        { repo: upstream.repo },
        { agent: { fake: 'agent' } },
      )
      assert.equal(pushed.ok, true, `the push after binding should succeed: ${pushed.error ?? ''}`)

      // The prompt appeared and its question clearly asks for a PAT
      assert.equal(asked.length, 1, 'the binding prompt should appear exactly once')
      assert.match(asked[0].questions[0].question, /Personal Access Token/)
      assert.equal(asked[0].agent.fake, 'agent', 'the agent that initiated the call must be passed along')

      // The token typed into the prompt is used to verify the identity
      assert.ok(seen.some(entry => entry.token === pastedToken), 'the identity should be verified with the token the user pasted')

      // The binding is persisted, so later calls do not ask again
      const listed = await call(tools, 'gh_account', { action: 'list' })
      assert.equal(listed.count, 1)
      assert.equal(listed.accounts[0].login, 'newbie')

      await call(tools, 'gh_repo', { repo: upstream.repo, action: 'status' })
      await call(tools, 'gh_file', { repo: upstream.repo, action: 'put', path: 'x.txt', content: 'x\n' })
      await call(tools, 'gh_commit', { repo: upstream.repo, message: 'feat: x' })
      await call(tools, 'gh_push', { repo: upstream.repo })
      assert.equal(asked.length, 1, 'no prompt should appear once an account is bound')
    })
  } finally {
    await upstream.http.close()
  }
})

await runner.test('skipping the prompt / having no question service does not block; a genuinely impossible operation gives an actionable error', async context => {
  const root = await context.setup()
  const upstream = await makeUpstream(root)
  try {
    const plugin = await loadPlugin()
    const base = {
      workspaceRoot: context.workspace,
      // Allow both the local test remote and me/*, so the create failure is "no credentials" rather than the allowlist.
      allowRepos: [upstream.allowRule, 'me/*'],
      allowPush: true,
      allowNonGithubRemotes: true,
    }
    const { runGit, repoDirName } = await import('../src/git.js')
    const dir = path.join(context.workspace, repoDirName(upstream.slug))
    assert.equal((await runGit(['clone', upstream.repo, dir])).ok, true)

    // Case 1: the user picks "skip" → respect it and do not block (a local/credential-free remote can still be pushed to).
    const skipContext = fakeContext({
      credentials: undefined,
      userQuestions: { async ask() { return { answers: [{ id: 'github_bind', selected: ['Skip, do not bind now'] }] } } },
    })
    plugin.apply(skipContext.ctx, { ...base, accountStorePath: path.join(root, 'skip.json') })
    const skippedPush = await call(skipContext.tools, 'gh_push', { repo: upstream.slug }, { agent: { fake: 1 } })
    assert.equal(skippedPush.ok, true, 'skipping the binding must not block a push to a local remote')

    // Case 2: no question service at all (subagent / no-UI runtime) → still no blocking and no hang.
    const noUi = fakeContext({ credentials: undefined, userQuestions: null })
    plugin.apply(noUi.ctx, {
      ...base,
      allowApiWrite: true,
      accountStorePath: path.join(root, 'noui.json'),
    })
    const pushed = await call(noUi.tools, 'gh_push', { repo: upstream.slug }, { agent: { fake: 1 } })
    assert.equal(pushed.ok, true, 'with no question service it must neither block nor hang')

    // Case 3: an operation that truly cannot continue (creating a remote repository needs a token) → the error must say how to bind.
    const error = await expectReject(
      () => call(noUi.tools, 'gh_repo',
        { repo: 'me/newrepo', action: 'create', name: 'newrepo', owner: 'me' },
        { agent: { fake: 1 } }),
      /needs GitHub credentials|no account is bound|401/, 
    )
    assert.match(error.message, /gh_account action=bind|credentials\.yaml|environment variable/, 'the error must say how to bind')

    // Case 4: the auto-prompt is switched off in the config → no prompt, but still no blocking.
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
    assert.equal(asked, 0, 'no prompt should appear once the auto-prompt is switched off')
  } finally {
    await upstream.http.close()
  }
})

await runner.test('gh_account always returns lossless JSON the host accepts', async context => {
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
        if (Object.getPrototypeOf(node) !== Object.prototype) problems.push(`${label}: not a plain object`)
        for (const [key, item] of Object.entries(node)) walk(item, `${label}.${key}`)
      }
      walk(value, JSON.stringify(args))
      assert.deepEqual(problems, [], `gh_account ${JSON.stringify(args)} contains invalid values: ${problems.join('; ')}`)
      assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    }
  })
})

/**
 * Assert that an operation is definitely rejected.
 * @param {() => unknown} operation
 * @param {RegExp} pattern
 */
async function expectReject(operation, pattern) {
  let failed
  try {
    const value = await operation()
    throw new Error(`expectReject: expected a rejection but the call succeeded: ${JSON.stringify(value)?.slice(0, 160)}`)
  } catch (error) {
    if (error instanceof Error && String(error.message).includes('expected a rejection')) throw error
    failed = error
  }
  const message = failed instanceof Error ? failed.message : String(failed)
  if (!pattern.test(message)) {
    throw new Error(`expectReject: the error message does not match ${pattern}, actual: ${message}`)
  }
  return failed
}

runner.finish()
