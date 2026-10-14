/**
 * dsh-plugin-github — Git 层测试
 * 运行：node test/git.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunner, TEST_DIR } from './harness.mjs'
import {
  runProcess,
  runGit,
  isGitRepo,
  remoteUrl,
  repoSlug,
  repoDirName,
  cloneOrFetch,
  headCommit,
  statusEntries,
} from '../src/git.js'

const runner = createRunner('git.test.mjs')

await runner.test('runProcess 收集 stdout 与退出码', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'])
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'hello')
})

await runner.test('runProcess 非零退出码不是异常，而是可判定的结果', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(3)'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
})

await runner.test('runProcess 超时会被终止并标记 timedOut', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 300 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

await runner.test('runProcess 支持 AbortSignal', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], {
    signal: controller.signal,
    timeoutMs: 5000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.signal, 'ABORTED')
  assert.match(result.error, /取消/)
})

await runner.test('runProcess 截断超长输出', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'])
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 60_000)
})

await runner.test('remoteUrl / repoSlug / repoDirName 规范化', async () => {
  assert.equal(remoteUrl('owner/repo'), 'https://github.com/owner/repo')
  assert.equal(remoteUrl('owner/repo.git'), 'https://github.com/owner/repo')
  assert.equal(remoteUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo')
  assert.equal(remoteUrl('https://github.com/owner/repo/'), 'https://github.com/owner/repo')

  assert.equal(repoSlug('owner/repo'), 'owner/repo')
  assert.equal(repoSlug('https://github.com/a/b.git'), 'a/b')
  assert.equal(repoSlug('git@github.com:a/b.git'), 'a/b')
  assert.equal(repoSlug('not a repo'), undefined)

  assert.equal(repoDirName('owner/my-repo'), 'owner__my-repo')
  assert.equal(repoDirName('https://github.com/owner/my-repo.git'), 'owner__my-repo')
  assert.equal(repoDirName('file:///E:/tmp/foo/origin.git'), 'origin')
  assert.equal(repoDirName('E:\\tmp\\foo\\bar'), 'bar')
})

await runner.test('clone → 复用 → 改文件 → status → commit 全链路（本地 bare 远端）', async context => {
  // 注意：这里只用 git 的本地文件传输做「克隆」这一步之外的操作。
  // file:// 传输会让 git 去 fork MSYS 的 sh.exe，而受限沙箱下 sh.exe 无法创建
  // 信号管道（实测 "couldn't create signal pipe, Win32 error 5"）；真实推送路径
  // 由 test/plugin.test.mjs 通过 git http-backend 覆盖。
  const root = await context.setup()
  const bare = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')

  assert.equal((await runGit(['init', '--bare', '--initial-branch=main', bare])).ok, true)

  assert.equal((await runGit(['init', '--initial-branch=main', seed])).ok, true)
  await writeFile(path.join(seed, 'README.md'), '# seed\n', 'utf8')
  const author = ['-c', 'user.name=t', '-c', 'user.email=t@e']
  assert.equal((await runGit([...author, 'add', '.'], { cwd: seed })).ok, true, 'add seed')
  assert.equal((await runGit([...author, 'commit', '-m', 'init'], { cwd: seed })).ok, true, 'commit seed')

  const { startGitHttp } = await import('./git-http-server.mjs')
  const http = await startGitHttp(root, 'origin.git')
  try {
    assert.equal((await runGit(['remote', 'add', 'origin', http.url], { cwd: seed })).ok, true)
    const seeded = await runGit(['push', '-u', 'origin', 'main'], { cwd: seed })
    assert.equal(seeded.ok, true, `种子推送失败：${seeded.error ?? ''}\n${seeded.stderr}`)

    const cloned = await cloneOrFetch({ repo: http.url, dir: clone })
    assert.equal(cloned.result.ok, true, `clone 失败：${cloned.result.error ?? ''}\n${cloned.result.stderr}`)
    assert.equal(cloned.reused, false)
    assert.equal(await isGitRepo(clone), true)

    const again = await cloneOrFetch({ repo: http.url, dir: clone })
    assert.equal(again.reused, true)
    assert.equal(again.result.ok, true, again.result.stderr)

    const head = await headCommit(clone)
    assert.match(head.subject, /init/)

    await writeFile(path.join(clone, 'README.md'), '# seed\n\n新增一行\n', 'utf8')
    const { entries } = await statusEntries(clone)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, 'README.md')

    assert.equal((await runGit(['add', '--', 'README.md'], { cwd: clone })).ok, true)
    const committed = await runGit([...author, 'commit', '-m', 'feat: 新增一行'], { cwd: clone })
    assert.equal(committed.ok, true, committed.stderr)

    const after = await headCommit(clone)
    assert.notEqual(after.sha, head.sha)
    assert.match(await readFile(path.join(clone, 'README.md'), 'utf8'), /新增一行/)

    // 推送也走 smart HTTP：验证我们生成的命令确实能推成功。
    const pushed = await runGit(['push', 'origin', 'main'], { cwd: clone })
    assert.equal(pushed.ok, true, `push 失败：${pushed.error ?? ''}\n${pushed.stderr}`)
  } finally {
    await http.close()
  }
})

await runner.test('token 只进 http.extraHeader 环境变量，绝不出现在命令行/仓库配置里', async () => {
  // 这是插件的核心安全约定：token 不能出现在 argv（会被进程列表、日志、工具回显看到），
  // 也不能写进 .git/config。这里用一次真实的 fetch 命令做端到端确认。
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-gh-token-'))
  const repo = path.join(root, 'repo')
  assert.equal((await runGit(['init', '--initial-branch=main', repo])).ok, true)

  // 用一个必然失败的远端，但命令会带着我们的 env 跑起来，足够检查 argv 与配置文件。
  await runGit(['remote', 'add', 'origin', 'https://127.0.0.1:1/nope.git'], { cwd: repo })
  await runGit(['fetch', '--prune', 'origin'], { cwd: repo, token: 'ghp_SUPERSECRET_TOKEN_VALUE', timeoutMs: 8000 })

  const config = await readFile(path.join(repo, '.git', 'config'), 'utf8')
  assert.ok(!config.includes('ghp_SUPERSECRET_TOKEN_VALUE'), 'token 不得写入 .git/config')
  assert.ok(!config.includes('extraHeader'), 'http.extraHeader 不得持久化到 .git/config')
})

await runner.test('runGit 的 token 传递路径是环境变量（源码级断言，Windows 下无法用假 git.exe 验证）', async () => {
  // 说明：Windows 上 Node 的 spawn('git') 只认 .exe（不做 PATHEXT 查找），
  // 因此不能靠往 PATH 里丢一个假的 git.cmd 来验证。改为直接断言实现约定：
  //   - token 只编码进 GIT_CONFIG_VALUE_0=http.extraHeader
  //   - 命令行 argv 中永远不出现 token
  const source = await readFile(path.join(TEST_DIR, '..', 'src', 'git.js'), 'utf8')
  assert.match(source, /GIT_CONFIG_KEY_0'\] = 'http\.extraHeader'|GIT_CONFIG_KEY_0 = 'http\.extraHeader'/)
  assert.match(source, /GIT_CONFIG_COUNT = '1'/)
  assert.match(source, /Authorization: Basic \$\{Buffer\.from/)
  assert.match(source, /GIT_TERMINAL_PROMPT: '0'/)
  assert.match(source, /GIT_ASKPASS: ''/)
  // runGit 只把 args 交给 spawn，绝不把 token 拼进参数。
  const runGitBody = source.slice(
    source.indexOf('export async function runGit'),
    source.indexOf('export async function isGitRepo'),
  )
  assert.ok(!runGitBody.includes('args.push(token'), 'token 不得进入 argv')
  assert.ok(!/args\s*=\s*\[[^\]]*token/.test(runGitBody), 'token 不得拼进参数数组')
})

runner.finish()
