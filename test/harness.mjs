/**
 * 测试基础设施。
 *
 * 为什么不直接用 node --test：DSH 的文件沙箱下 node:test 的 runner 会用
 * `child_process.spawn` + 管道启动测试子进程，管道 stdio 在受限模式下返回 EPERM。
 * 因此这里自己实现一个极简 harness：每个测试文件直接 `node xxx.test.mjs` 运行，
 * 用真实 git 子进程 + 真实文件系统完成端到端验证。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.join(TEST_DIR, '..')

/** 极简测试运行器。 */
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
 * 载入插件模块。
 *
 * 注意：这里**不能**用 `?t=…` 之类的查询串做缓存破坏。插件是相对导入
 * （`./tools.js` → `./git.js`），给入口加查询串只会让入口重新求值，而依赖会被
 * 缓存成**第二份实例**；两份实例混用会让 async 函数的拒绝逃逸成进程级
 * unhandledRejection（已实测），排查代价极高。
 * 插件把模块级状态重置暴露成 `__resetForTests()`，测试复用它。
 */
export async function loadPlugin() {
  const mod = await import('../src/index.js')
  mod.__resetForTests?.()
  return mod
}

/**
 * 造一个假的 Cordis ctx：只实现插件真正用到的那几个成员，
 * 并且像真实 dsh-tools 一样强制校验 output.schema + output.render。
 *
 * `userQuestions` 的默认值是「跳过型」桩：它存在但总是让用户跳过绑定。
 * 这贴合默认行为（不弹窗、不绑定），需要验证引导的用例显式传入自己的实现；
 * 想模拟「完全没有问答服务」的运行时，传 `userQuestions: null`。
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
        assert.ok(definition?.name, '工具定义缺少 name')
        assert.equal(typeof definition.description, 'string', `工具 ${definition.name} 缺少 description`)
        assert.equal(typeof definition.parameters, 'object', `工具 ${definition.name} 缺少 parameters`)
        assert.ok(definition.output && typeof definition.output === 'object', `工具 ${definition.name} 缺少 output`)
        assert.ok(definition.output.schema && typeof definition.output.schema === 'object', `工具 ${definition.name} 的 output.schema 非法`)
        assert.equal(typeof definition.output.render, 'function', `工具 ${definition.name} 的 output.render 非法`)
        assert.equal(typeof definition.execute, 'function', `工具 ${definition.name} 缺少 execute`)
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

/** 调用一个工具，返回它声明的 canonical 值。 */
export async function call(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `工具 ${name} 未注册`)
  return await definition.execute(args, { signal: undefined, ...exec })
}

/** 准备一个本地 bare 远端 + 种子提交，并用 smart HTTP 暴露（不依赖网络，也不依赖 sh.exe）。 */
export async function makeUpstream(root) {
  const { runGit } = await import('../src/git.js')
  const { startGitHttp } = await import('./git-http-server.mjs')
  const bare = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  await mkdir(bare, { recursive: true })
  assert.equal((await runGit(['init', '--bare', '--initial-branch=main', bare])).ok, true, '初始化 bare 仓库')
  assert.equal((await runGit(['config', 'http.receivepack', 'true'], { cwd: bare })).ok, true, '允许 HTTP 推送')
  assert.equal((await runGit(['init', '--initial-branch=main', seed])).ok, true, '初始化种子仓库')
  await writeFile(path.join(seed, 'README.md'), '# demo\n\n第一行\n', 'utf8')
  await writeFile(path.join(seed, 'src.txt'), 'a\nb\nc\n', 'utf8')
  const author = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
  assert.equal((await runGit([...author, 'add', '.'], { cwd: seed })).ok, true, '种子 add')
  assert.equal((await runGit([...author, 'commit', '-m', 'init'], { cwd: seed })).ok, true, '种子 commit')

  const http = await startGitHttp(root, 'origin.git')
  assert.equal((await runGit(['remote', 'add', 'origin', http.url], { cwd: seed })).ok, true, '加 remote')
  const pushed = await runGit(['push', '-u', 'origin', 'main'], { cwd: seed })
  assert.equal(pushed.ok, true, `种子推送失败：${pushed.error ?? ''}\n${pushed.stderr}`)

  // 白名单规则与目录名都由真实实现派生，避免测试里手写、与实现脱节。
  const { repoSlug, repoDirName } = await import('../src/git.js')
  const slug = repoSlug(http.url)
  return {
    bare,
    seed,
    repo: http.url,
    /** 该远端对应的规范 slug（allowRepos 只接受严格 owner/repo）。 */
    slug,
    allowRule: slug,
    /** @deprecated 保留旧字段名兼容。 */
    fileUrl: http.url,
    http,
    dirName: repoDirName(http.url),
  }
}

/** 用假的 fetch 拦截 GitHub API。 */
export async function withFakeFetch(handler, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}
