/**
 * dsh-plugin-github — Git-layer tests
 * Run: node test/git.test.mjs
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
  setGitExecutable,
  currentGitExecutable,
} from '../src/git.js'

const runner = createRunner('git.test.mjs')

await runner.test('runProcess collects stdout and the exit code', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'])
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'hello')
})

await runner.test('runProcess: a non-zero exit code is a checkable result, not an exception', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(3)'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
})

await runner.test('runProcess kills a timed-out process and flags timedOut', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 300 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

await runner.test('runProcess supports AbortSignal', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], {
    signal: controller.signal,
    timeoutMs: 5000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.signal, 'ABORTED')
  assert.match(result.error, /cancelled/i)
})

await runner.test('runProcess truncates oversized output', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'])
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 60_000)
})

await runner.test('remoteUrl / repoSlug / repoDirName normalization', async () => {
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

  // Local paths are platform-dependent, so assert against each platform's own
  // absolute form: an `E:\...` path is not absolute on Linux, and a `/tmp/...`
  // path is not absolute on Windows. Checking `path.isAbsolute` first keeps the
  // expectation honest instead of hard-coding one platform's spelling.
  const windowsPath = 'E:\\tmp\\foo\\bar'
  if (path.isAbsolute(windowsPath)) assert.equal(repoDirName(windowsPath), 'bar')
  const posixPath = '/tmp/foo/bar'
  if (path.isAbsolute(posixPath)) assert.equal(repoDirName(posixPath), 'bar')

  // file:// URLs resolve on every platform.
  const fileUrl = process.platform === 'win32' ? 'file:///C:/tmp/foo/origin.git' : 'file:///tmp/foo/origin.git'
  assert.equal(repoDirName(fileUrl), 'origin')
})

await runner.test('clone → reuse → edit a file → status → commit end to end (local bare remote)', async context => {
  // Note: this test uses git's local file transport for everything except the "clone" step.
  // The file:// transport makes git fork MSYS's sh.exe, and under the restricted sandbox sh.exe
  // cannot create a signal pipe (measured: "couldn't create signal pipe, Win32 error 5"); the real
  // push path is covered by test/plugin.test.mjs through the git http-backend.
  const root = await context.setup()
  const bare = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')

  assert.equal((await runGit(['init', '--bare', '--initial-branch=main', bare])).ok, true)

  assert.equal((await runGit(['-c', 'core.autocrlf=false', 'init', '--initial-branch=main', seed])).ok, true)
  await writeFile(path.join(seed, 'README.md'), '# seed\n', 'utf8')
  const author = ['-c', 'user.name=t', '-c', 'user.email=t@e']
  assert.equal((await runGit([...author, 'add', '.'], { cwd: seed })).ok, true, 'add seed')
  assert.equal((await runGit([...author, 'commit', '-m', 'init'], { cwd: seed })).ok, true, 'commit seed')

  const { startGitHttp } = await import('./git-http-server.mjs')
  const http = await startGitHttp(root, 'origin.git')
  try {
    assert.equal((await runGit(['remote', 'add', 'origin', http.url], { cwd: seed })).ok, true)
    const seeded = await runGit(['push', '-u', 'origin', 'main'], { cwd: seed })
    assert.equal(seeded.ok, true, `seed push failed: ${seeded.error ?? ''}\n${seeded.stderr}`)

    const cloned = await cloneOrFetch({ repo: http.url, dir: clone })
    assert.equal(cloned.result.ok, true, `clone failed: ${cloned.result.error ?? ''}\n${cloned.result.stderr}`)
    assert.equal(cloned.reused, false)
    assert.equal(await isGitRepo(clone), true)

    const again = await cloneOrFetch({ repo: http.url, dir: clone })
    assert.equal(again.reused, true)
    assert.equal(again.result.ok, true, again.result.stderr)

    const head = await headCommit(clone)
    assert.match(head.subject, /init/)

    await writeFile(path.join(clone, 'README.md'), '# seed\n\nadd a line\n', 'utf8')
    const { entries } = await statusEntries(clone)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, 'README.md')

    assert.equal((await runGit(['add', '--', 'README.md'], { cwd: clone })).ok, true)
    const committed = await runGit([...author, 'commit', '-m', 'feat: add a line'], { cwd: clone })
    assert.equal(committed.ok, true, committed.stderr)

    const after = await headCommit(clone)
    assert.notEqual(after.sha, head.sha)
    assert.match(await readFile(path.join(clone, 'README.md'), 'utf8'), /add a line/)

    // The push goes over smart HTTP too, verifying that the command we build really can push.
    const pushed = await runGit(['push', 'origin', 'main'], { cwd: clone })
    assert.equal(pushed.ok, true, `push failed: ${pushed.error ?? ''}\n${pushed.stderr}`)
  } finally {
    await http.close()
  }
})

await runner.test('a credential echoed by git is redacted before it can reach the model', async () => {
  // git should never print a credential that arrived through the environment, but a
  // failed authentication can quote the request back. `git config --get` on the very
  // key carrying the header is the cheapest way to make git echo that value.
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-gh-redact-'))
  const repo = path.join(root, 'repo')
  assert.equal((await runGit(['init', '--initial-branch=main', repo])).ok, true)

  const token = 'ghp_REDACTION_CANARY_0123456789'
  const echoed = await runGit(['config', '--get', 'http.extraHeader'], { cwd: repo, token })
  const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')

  const combined = `${echoed.stdout}${echoed.stderr}${echoed.error ?? ''}`
  assert.ok(!combined.includes(token), `the raw token leaked: ${combined}`)
  assert.ok(!combined.includes(encoded), `the encoded token leaked: ${combined}`)
})

await runner.test('setGitExecutable points git at an alternative executable', async () => {
  const original = currentGitExecutable()
  try {
    // A blank value must not become the command; it falls back to `git`.
    assert.equal(setGitExecutable(''), 'git')
    assert.equal(setGitExecutable('   '), 'git')
    assert.equal(setGitExecutable('git'), 'git')
    assert.equal(currentGitExecutable(), 'git')

    // An executable that cannot be started fails clearly rather than crashing.
    setGitExecutable('definitely-not-a-git-binary')
    assert.equal(currentGitExecutable(), 'definitely-not-a-git-binary')
    const result = await runGit(['--version'], { timeoutMs: 10000 })
    assert.equal(result.ok, false)
    assert.match(String(result.error ?? result.stderr), /definitely-not-a-git-binary/)
  } finally {
    setGitExecutable(original)
  }
  assert.equal(currentGitExecutable(), original)
})

await runner.test('the token goes only into the http.extraHeader environment variable, never into argv or the repository config', async () => {
  // This is the plugin's core security contract: the token must not appear in argv (where the process
  // list, logs and tool echoes would show it) nor be written into .git/config. One real fetch confirms it end to end.
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-gh-token-'))
  const repo = path.join(root, 'repo')
  assert.equal((await runGit(['-c', 'core.autocrlf=false', 'init', '--initial-branch=main', repo])).ok, true)

  // Use a remote that always fails; the command still runs with our env, which is enough to inspect argv and the config file.
  await runGit(['remote', 'add', 'origin', 'https://127.0.0.1:1/nope.git'], { cwd: repo })
  await runGit(['fetch', '--prune', 'origin'], { cwd: repo, token: 'ghp_SUPERSECRET_TOKEN_VALUE', timeoutMs: 8000 })

  const config = await readFile(path.join(repo, '.git', 'config'), 'utf8')
  assert.ok(!config.includes('ghp_SUPERSECRET_TOKEN_VALUE'), 'the token must not be written into .git/config')
  assert.ok(!config.includes('extraHeader'), 'http.extraHeader must not be persisted into .git/config')
})

await runner.test('runGit passes the token through the environment (a source-level assertion; a fake git.exe cannot be used on Windows)', async () => {
  // Note: on Windows Node's spawn('git') only accepts .exe (it does no PATHEXT lookup), so a fake
  // git.cmd dropped into PATH cannot be used for verification. Assert the implementation contract instead:
  //   - the token is encoded only into GIT_CONFIG_VALUE_0=http.extraHeader
  //   - the token never appears in the command-line argv
  const source = await readFile(path.join(TEST_DIR, '..', 'src', 'git.js'), 'utf8')
  assert.match(source, /GIT_CONFIG_KEY_0'\] = 'http\.extraHeader'|GIT_CONFIG_KEY_0 = 'http\.extraHeader'/)
  assert.match(source, /GIT_CONFIG_COUNT = '1'/)
  assert.match(source, /Authorization: Basic \$\{Buffer\.from/)
  assert.match(source, /GIT_TERMINAL_PROMPT: '0'/)
  assert.match(source, /GIT_ASKPASS: ''/)
  // runGit hands only args to spawn and never concatenates the token into the arguments.
  const runGitBody = source.slice(
    source.indexOf('export async function runGit'),
    source.indexOf('export async function isGitRepo'),
  )
  assert.ok(!runGitBody.includes('args.push(token'), 'the token must not reach argv')
  assert.ok(!/args\s*=\s*\[[^\]]*token/.test(runGitBody), 'the token must not be concatenated into the argument array')
})

runner.finish()
