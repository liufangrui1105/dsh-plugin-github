/**
 * Test infrastructure.
 *
 * Why not use `node --test` directly: under the DSH file sandbox, the node:test
 * runner starts test child processes with `child_process.spawn` + pipes, and
 * piped stdio returns EPERM in restricted mode.
 * So we implement a minimal harness of our own here: each test file is run
 * directly as `node xxx.test.mjs`, using real git child processes + the real
 * filesystem for end-to-end verification.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.join(TEST_DIR, '..')

/** A minimal test runner. */
export function createRunner(name) {
  const results = []
  let current = null

  return {
    async test(title, fn) {
      current = title
      const started = Date.now()
      const root = await mkdtemp(path.join(tmpdir(), 'dsh-gh-case-'))
      const context = {
        root,
        workspace: path.join(root, 'ws'),
        async setup() {
          await mkdir(context.workspace, { recursive: true })
          return context.workspace
        },
      }
      try {
        await fn(context)
        results.push({ title, ok: true, ms: Date.now() - started })
        console.log(`  ok   ${title}`)
      } catch (error) {
        results.push({ title, ok: false, ms: Date.now() - started, error })
        console.log(`  FAIL ${title}`)
        console.log(`       ${error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n       ') : String(error)}`)
      } finally {
        current = null
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    },

    finish() {
      const failed = results.filter(entry => !entry.ok)
      console.log('')
      console.log(`  ${results.length - failed.length} passed, ${failed.length} failed  (${name})`)
      if (failed.length > 0) process.exitCode = 1
      return failed.length === 0
    },

    get current() {
      return current
    },
  }
}

/**
 * Load the plugin module.
 *
 * Note: we must **not** use a cache-busting query string such as `?t=…` here.
 * The plugin uses relative imports (`./tools.js` → `./git.js`), and adding a
 * query string to the entry point only makes the entry re-evaluate while the
 * dependencies stay cached as a **second module instance**; mixing the two
 * instances lets an async function's rejection escape as a process-level
 * unhandledRejection (measured in practice), which is extremely expensive to
 * diagnose.
 * The plugin exposes its module-level state reset as `__resetForTests()`, and
 * the tests reuse it.
 */
export async function loadPlugin() {
  const mod = await import('../src/index.js')
  mod.__resetForTests?.()
  return mod
}

/**
 * Build a fake Cordis ctx: it implements only the few members the plugin
 * really uses, and, like the real dsh-tools, strictly validates
 * output.schema + output.render.
 *
 * The default value of `userQuestions` is a "skip-style" stub: it exists but
 * always lets the user skip binding. This matches the default behavior (no
 * prompt, no binding); cases that need to verify the guidance flow pass their
 * own implementation explicitly; to simulate a runtime with "no question
 * service at all", pass `userQuestions: null`.
 * @param {{credentials?: unknown, userQuestions?: unknown, agents?: unknown}} [options]
 */
export function fakeContext(options = {}) {
  const { credentials, agents } = options
  const userQuestions = Object.hasOwn(options, 'userQuestions') ? options.userQuestions : undefined
  const questions = userQuestions === undefined
    ? { async ask() { return { answers: [] } } }
    : userQuestions === null ? undefined : userQuestions
  const tools = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
      debug: (...args) => logs.push(['debug', args.join(' ')]),
    },
    tools: {
      register(definition) {
        assert.ok(definition?.name, 'tool definition is missing name')
        assert.equal(typeof definition.description, 'string', `tool ${definition.name} is missing description`)
        assert.equal(typeof definition.parameters, 'object', `tool ${definition.name} is missing parameters`)
        assert.ok(definition.output && typeof definition.output === 'object', `tool ${definition.name} is missing output`)
        assert.ok(definition.output.schema && typeof definition.output.schema === 'object', `tool ${definition.name} has an invalid output.schema`)
        assert.equal(typeof definition.output.render, 'function', `tool ${definition.name} has an invalid output.render`)
        assert.equal(typeof definition.execute, 'function', `tool ${definition.name} is missing execute`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'userQuestions') return questions
      if (name === 'agents') return agents
      return undefined
    },
    effect() {},
  }
  return { ctx, tools, logs }
}

/** Invoke a tool and return its declared canonical value. */
export async function call(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  return await definition.execute(args, { signal: undefined, ...exec })
}

/** Prepare a local bare remote + seed commit and expose it over smart HTTP (depends on neither the network nor sh.exe). */
export async function makeUpstream(root) {
  const { runGit } = await import('../src/git.js')
  const { startGitHttp } = await import('./git-http-server.mjs')
  const bare = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  await mkdir(bare, { recursive: true })
  assert.equal((await runGit(['init', '--bare', '--initial-branch=main', bare])).ok, true, 'init bare repo')
  assert.equal((await runGit(['config', 'http.receivepack', 'true'], { cwd: bare })).ok, true, 'allow HTTP push')
  assert.equal((await runGit(['init', '--initial-branch=main', seed])).ok, true, 'init seed repo')
  await writeFile(path.join(seed, 'README.md'), '# demo\n\nfirst line\n', 'utf8')
  await writeFile(path.join(seed, 'src.txt'), 'a\nb\nc\n', 'utf8')
  const author = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
  assert.equal((await runGit([...author, 'add', '.'], { cwd: seed })).ok, true, 'seed add')
  assert.equal((await runGit([...author, 'commit', '-m', 'init'], { cwd: seed })).ok, true, 'seed commit')

  const http = await startGitHttp(root, 'origin.git')
  assert.equal((await runGit(['remote', 'add', 'origin', http.url], { cwd: seed })).ok, true, 'add remote')
  const pushed = await runGit(['push', '-u', 'origin', 'main'], { cwd: seed })
  assert.equal(pushed.ok, true, `seed push failed: ${pushed.error ?? ''}\n${pushed.stderr}`)

  // Both the allow-list rule and the directory name are derived from the real implementation, to avoid hand-writing them in tests and drifting from the implementation.
  const { repoSlug, repoDirName } = await import('../src/git.js')
  const slug = repoSlug(http.url)
  return {
    bare,
    seed,
    repo: http.url,
    /** The canonical slug for this remote (allowRepos accepts only a strict owner/repo). */
    slug,
    allowRule: slug,
    /** @deprecated kept for compatibility with the old field name. */
    fileUrl: http.url,
    http,
    dirName: repoDirName(http.url),
  }
}

/** Intercept the GitHub API with a fake fetch. */
export async function withFakeFetch(handler, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}
