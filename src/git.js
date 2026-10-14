/**
 * dsh-plugin-github — Git 执行层
 *
 * 纯 Node.js 实现，不依赖任何 DSH 内部包，方便单独测试。
 * 所有 git 子进程都走 runProcess()，统一处理：
 *   - 参数数组传参（绝不拼接 shell 字符串，避免注入）
 *   - 超时与 AbortSignal
 *   - stdout/stderr 截断
 *   - Windows 下隐藏控制台窗口
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import path from 'node:path'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** 单次 git 命令的默认超时。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 返回给模型前，stdout / stderr 各自的截断上限（字符）。 */
export const MAX_OUTPUT_CHARS = 60_000

/**
 * 执行一个外部进程并收集输出。
 *
 * 为什么用「临时文件 + 文件描述符」而不是 `stdio: ['pipe','pipe','pipe']`：
 * DSH 的文件沙箱下，Node 的管道 stdio 依赖命名管道，受限模式会直接返回
 * `spawn EPERM`（实测）。把子进程的 stdout/stderr 重定向到临时文件后，
 * 只用到文件 I/O，在受限与不受限两种模式下都能正常工作，也不需要
 * shell 解释字符串——参数始终以数组传入，不经过 shell，天然免疫命令注入。
 *
 * @param {string} command 可执行文件
 * @param {string[]} args 参数数组
 * @param {{cwd?: string, env?: Record<string, string|undefined>, signal?: AbortSignal, timeoutMs?: number, input?: string}} options
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null, stdout: string, stderr: string, truncated: boolean, timedOut: boolean, aborted: boolean, error?: string}>}
 */
export async function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    input,
  } = options

  let scratch
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'dsh-gh-'))
  } catch (error) {
    return failure(`无法创建临时目录：${message(error)}`)
  }
  const outPath = path.join(scratch, 'stdout.txt')
  const errPath = path.join(scratch, 'stderr.txt')

  let stdinPath
  let outHandle
  let errHandle
  let stdinHandle
  try {
    outHandle = await open(outPath, 'w')
    errHandle = await open(errPath, 'w')
    if (input !== undefined) {
      stdinPath = path.join(scratch, 'stdin.txt')
      stdinHandle = await open(stdinPath, 'w')
      await stdinHandle.writeFile(input, 'utf8')
      await stdinHandle.close()
      stdinHandle = undefined
    }
  } catch (error) {
    await closeQuietly(outHandle, errHandle, stdinHandle)
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    return failure(`无法创建输出文件：${message(error)}`)
  }

  const result = await new Promise(resolve => {
    let stdinFd = -1
    if (input !== undefined) {
      try {
        stdinFd = openSync(stdinPath, 'r')
      } catch (error) {
        resolve({ kind: 'error', error: `无法打开 stdin 文件：${message(error)}` })
        return
      }
    }
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer

    const done = outcome => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (stdinFd >= 0) {
        try {
          closeSyncFd(stdinFd)
        } catch {
          /* 子进程可能已接管 */
        }
      }
      resolve(outcome)
    }

    const onAbort = () => {
      kill()
      done({ kind: 'aborted' })
    }

    function kill() {
      try {
        child?.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        // 关键：stdout/stderr 走文件描述符，stdin 走文件，全都不用命名管道。
        stdio: [stdinFd >= 0 ? stdinFd : 'ignore', outHandle.fd, errHandle.fd],
      })
    } catch (error) {
      done({ kind: 'error', error: `无法启动 ${command}: ${message(error)}` })
      return
    }

    timer = setTimeout(() => {
      kill()
      done({ kind: 'timeout' })
    }, timeoutMs)
    timer.unref?.()

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', error => done({ kind: 'error', error: `进程错误: ${message(error)}` }))
    child.on('close', (code, closeSignal) => done({ kind: 'close', code, closeSignal }))
  })

  await outHandle.close().catch(() => {})
  await errHandle.close().catch(() => {})

  const stdout = await readCapped(outPath)
  const stderr = await readCapped(errPath)
  await rm(scratch, { recursive: true, force: true }).catch(() => {})

  const truncated = stdout.truncated || stderr.truncated
  const base = {
    code: null, signal: null,
    stdout: stdout.text, stderr: stderr.text,
    truncated, timedOut: false, aborted: false,
  }

  if (result.kind === 'error') return { ...base, ok: false, error: result.error }
  if (result.kind === 'aborted') {
    return { ...base, ok: false, aborted: true, signal: 'ABORTED', error: '调用已被取消（AbortSignal）' }
  }
  if (result.kind === 'timeout') {
    return {
      ...base, ok: false, timedOut: true, signal: 'TIMEOUT',
      error: `命令超时（${timeoutMs}ms）：${command} ${args.join(' ')}`,
    }
  }
  return { ...base, ok: result.code === 0, code: result.code, signal: result.closeSignal }
}

function failure(error) {
  return {
    ok: false, code: null, signal: null, stdout: '', stderr: '',
    truncated: false, timedOut: false, aborted: false, error,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 关闭同步打开的文件描述符。 */
function closeSyncFd(fd) {
  closeSync(fd)
}

async function closeQuietly(...handles) {
  for (const handle of handles) {
    if (handle && typeof handle.close === 'function') await handle.close().catch(() => {})
  }
}

/** 读取输出文件并按上限截断。 */
async function readCapped(file) {
  try {
    const buffer = await readFile(file)
    const text = buffer.toString('utf8')
    if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
    return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
  } catch {
    return { text: '', truncated: false }
  }
}

/** git 需要的、屏蔽交互与证书提示的环境变量。 */
function gitEnv(token) {
  /** @type {Record<string, string>} */
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '0',
    LC_ALL: 'C',
  }
  if (token) {
    // 不写进 .git/config，不写进命令行：只作为单次进程的 -c 配置传入。
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
  }
  return env
}

/**
 * 执行一条 git 命令。
 * @param {string[]} args
 * @param {{cwd?: string, token?: string, signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function runGit(args, options = {}) {
  const { cwd, token, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const result = await runProcess('git', args, {
    cwd,
    env: gitEnv(token),
    signal,
    timeoutMs,
  })
  return { ...result, command: `git ${args.join(' ')}` }
}

/**
 * 判断某个路径是否是一个 git 工作区。
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(dir) {
  try {
    const info = await stat(path.join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * 把各种形态的仓库标识转成 HTTPS 克隆地址。
 * 只把 `owner/repo`（以及裸 git@ 形式）补全成 github.com 地址；
 * 已经是 http(s):// 或 file:// 的地址原样返回——否则本地/自建服务会被改写成 github.com。
 * @param {string} repo
 * @returns {string}
 */
export function remoteUrl(repo) {
  const value = String(repo ?? '').trim()
  if (/^(https?|file):\/\//i.test(value)) return value.replace(/\/+$/, '')
  if (/^git@/i.test(value)) {
    const rest = value.replace(/^git@[^:]+:/, '')
    return `https://github.com/${rest.replace(/\.git$/, '')}`
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || path.isAbsolute(value)) return value
  return `https://github.com/${value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`
}

/** owner/repo 形式（去掉 .git）；无法识别时返回 undefined。 */
export function repoSlug(repo) {
  const value = String(repo ?? '').trim()

  // HTTP(S) 用 URL 解析而不是正则：主机可带端口，路径段数也不固定，
  // 手写正则很容易在 "host:port/owner/repo" 上错误回溯（实测踩过）。
  if (/^https?:\/\//i.test(value)) {
    const trailingHost = /^https?:\/\/[^/\s]+$/i.test(value)
    if (!trailingHost) {
      // 本测试/自建服务场景：主机根下直接挂一个仓库（path 只有一段），
      // 用主机名当 owner，这样白名单语法 owner/* 依然可用。
      let host
      let segments = []
      try {
        const parsed = new URL(value)
        host = parsed.hostname
        segments = parsed.pathname.split('/').filter(Boolean).map(part => part.replace(/\.git$/i, ''))
      } catch {
        host = undefined
      }
      if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
      if (segments.length === 1 && host) return `${host}/${segments[0]}`
    }
  }

  const ssh = value.match(/^git@[^:\s]+:([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  const plain = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (plain) return `${plain[1]}/${plain[2]}`
  return undefined
}

/**
 * 判断标识是否为本地路径（file:// 或绝对路径）。
 * 注意 Windows 上 `path.isAbsolute('http://…')` 会返回 true，必须先排除 http(s)。
 */
export function isLocalRepoRef(repo) {
  const value = String(repo ?? '').trim()
  if (/^https?:\/\//i.test(value)) return false
  return value.startsWith('file://') || path.isAbsolute(value)
}

/**
 * 本地目录名（克隆时用）。
 *
 * 用 `<owner>__<repo>` 而不是裸的 `<repo>`：只取 basename 会让 `alice/tool`
 * 和 `bob/tool` 撞进同一个目录，进而把改动推到错误的远端（审查发现 D1）。
 * 两个下划线作为分隔，避免与合法的 owner/repo 字符集（允许单下划线）混淆。
 */
export function repoDirName(repo) {
  const value = String(repo ?? '').trim()
  const slug = repoSlug(value)
  if (slug) {
    const [owner, name] = slug.split('/')
    return `${owner}__${name}`.replace(/[^A-Za-z0-9_.-]/g, '_')
  }
  if (isLocalRepoRef(value)) {
    const plain = value.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/').replace(/\/+$/, '')
    const base = path.basename(plain).replace(/\.git$/, '')
    return base === '' ? 'repo' : base
  }
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * 读取本地克隆的 origin 地址。
 * @param {string} cwd
 * @param {{token?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<string | undefined>}
 */
export async function originUrl(cwd, options = {}) {
  const result = await runGit(['remote', 'get-url', 'origin'], { cwd, ...options })
  if (!result.ok) return undefined
  const value = result.stdout.trim()
  return value === '' ? undefined : value
}

/**
 * 读取本地克隆**推送时实际会用**的地址。
 *
 * 关键：`git remote get-url origin` 返回的是 fetch URL，而 `git push` 会优先用
 * `remote.<name>.pushurl`。只看 fetch URL 会让「授权校验的地址」和「真正被访问的地址」
 * 不一致——一个被写入 .git/config 的 pushurl 就能把带 PAT 的请求送到别的主机。
 * @param {string} cwd
 * @param {{token?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<string[]>} 所有推送地址（去重后）
 */
export async function pushUrls(cwd, options = {}) {
  const result = await runGit(['remote', 'get-url', '--push', '--all', 'origin'], { cwd, ...options })
  if (!result.ok) return []
  return [...new Set(result.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
}

/**
 * 校验一个远端地址是否指向被允许的 GitHub 主机。
 *
 * 白名单规则只约束 `owner/repo`，不约束主机；如果插件的 token 会被送到任意主机，
 * 那么「白名单里的 slug 出现在攻击者域名下」就是一次凭据外泄。因此：
 *   - `owner/repo` 这种规范形式一律解析到 github.com（由 remoteUrl 补全）
 *   - 已经是 URL 的形式只允许 github.com / www.github.com
 *   - file:// 与本地路径不联网，无条件放行
 *   - 自建 Git 服务需要一个显式开关（allowNonGithubRemotes），因为「允许任意主机」
 *     等于「允许把凭据发给任意主机」
 * @param {string} url
 * @param {boolean} [allowNonGithub]
 * @returns {string | undefined} 不允许时返回原因
 */
export function assertAllowedHost(url, allowNonGithub = false) {
  const value = String(url ?? '').trim()
  if (value === '') return undefined
  if (allowNonGithub) return undefined
  if (/^file:\/\//i.test(value)) return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // 没有 scheme：ssh 简写（git@host:path）或本地路径
    const ssh = value.match(/^git@([^:\s]+):/i)
    if (ssh) return ssh[1].toLowerCase() === 'github.com' ? undefined : `远端主机 ${ssh[1]} 不是 github.com`
    if (/^[A-Za-z]:[\\/]/.test(value) || path.isAbsolute(value)) return undefined
    return undefined
  }
  let host
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    return `无法解析远端地址：${value}`
  }
  if (host === 'github.com' || host === 'www.github.com') return undefined
  return `远端主机 ${host} 不在允许列表内（只允许 github.com）。`
    + '确实要用自建 Git 服务时，请在插件配置里显式设置 allowNonGithubRemotes: true'
    + '（注意：这等于允许把凭据发给你指定的任何主机）。'
}

/**
 * 确认本地目录的 origin 确实是请求的那个仓库。
 *
 * 这是授权模型的关键一环：白名单校验的是 `args.repo`，而实际推送/拉取的是
 * 目录里的 origin。两者若不一致，白名单就可能授权到另一个仓库（审查发现 D1/D11）。
 *
 * 刻意写成**同步函数**（调用方先把 origin 取出来传进来）：同步函数里的 throw 在任何
 * 环境下都是普通异常；而 async 函数内部的 throw 依赖运行时把拒绝正确地传播进 promise
 * 链——在这台机器的 Node 24.19 上实测会逃逸成进程级 unhandledRejection。
 *
 * @param {{actual: string | undefined, requested: string, dir: string, kind?: string, allowNonGithub?: boolean}} options
 * @returns {string} 实际 origin 地址
 * @throws {Error} 当 origin 缺失、与请求的仓库不一致，或指向不被允许的主机
 */
export function assertOriginMatches(options) {
  const { actual, requested, dir, kind = 'origin', allowNonGithub = false } = options
  if (actual === undefined || String(actual).trim() === '') {
    throw new Error(
      `本地目录 ${dir} 没有 ${kind}，无法确认它就是 ${requested}。`
      + '请删除该目录后重新 gh_repo action=clone。',
    )
  }
  const hostProblem = assertAllowedHost(actual, allowNonGithub)
  if (hostProblem !== undefined) {
    throw new Error(
      `拒绝操作：本地目录 ${dir} 的 ${kind} 是 ${actual}，${hostProblem}。`
      + '继续操作会把凭据发给一个不受信任的主机。',
    )
  }
  const actualSlug = repoSlug(actual)
  const requestedSlug = repoSlug(requested)
  const same = actualSlug !== undefined && requestedSlug !== undefined
    ? actualSlug.toLowerCase() === requestedSlug.toLowerCase()
    : normalizeRemote(actual) === normalizeRemote(requested)
  if (!same) {
    throw new Error(
      `拒绝操作：本地目录 ${dir} 的 ${kind} 是 ${actual}（${actualSlug ?? '无法识别'}），`
      + `而请求的是 ${requested}（${requestedSlug ?? '无法识别'}）。`
      + '目录内容与请求的仓库不一致，继续操作可能把改动推到错误的远端。'
      + '请用 gh_repo action=clone 克隆到干净目录，或检查 allowRepos 与 repo 参数。',
    )
  }
  return actual
}

/** 归一化远端地址用于比较：去掉尾部斜杠与 .git，统一小写。 */
export function normalizeRemote(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
}

/**
 * 克隆（或复用已存在的本地克隆）。已存在且是 git 仓库时只做 fetch。
 * @param {{repo: string, dir: string, token?: string, signal?: AbortSignal, depth?: number}} options
 */
export async function cloneOrFetch(options) {
  const { repo, dir, token, signal, depth } = options
  // remoteUrl 现在对各种形态都是幂等的：owner/repo → github，URL/本地路径原样。
  const target = options.remote ?? remoteUrl(repo)
  await mkdir(path.dirname(dir), { recursive: true })

  if (await isGitRepo(dir)) {
    const fetchArgs = ['fetch', '--prune', 'origin']
    if (depth && depth > 0) fetchArgs.push(`--depth=${depth}`)
    const fetched = await runGit(fetchArgs, { cwd: dir, token, signal })
    return { reused: true, result: fetched }
  }

  const args = ['clone']
  if (depth && depth > 0) args.push(`--depth=${depth}`)
  args.push(target, dir)
  const result = await runGit(args, { token, signal, timeoutMs: 300_000 })
  return { reused: false, result }
}

/** 当前 HEAD 的短 sha 与提交标题。 */
export async function headCommit(cwd, options = {}) {
  const result = await runGit(['log', '-1', '--pretty=format:%h%x09%s'], { cwd, ...options })
  if (!result.ok) return undefined
  const [sha, ...rest] = result.stdout.split('\t')
  return { sha: sha.trim(), subject: rest.join('\t').trim() }
}

/**
 * 解析 git status --porcelain=v1 -uall。
 * @param {string} cwd
 * @param {{token?: string, signal?: AbortSignal}} options
 */
export async function statusEntries(cwd, options = {}) {
  const result = await runGit(['status', '--porcelain=v1', '-uall'], { cwd, ...options })
  if (!result.ok) return { entries: [], result }
  const entries = result.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => ({ code: line.slice(0, 2).trim(), path: line.slice(3) }))
  return { entries, result }
}

/**
 * 读取一次 diff。
 * @param {{cwd: string, staged?: boolean, path?: string, maxChars?: number, token?: string, signal?: AbortSignal}} options
 */
export async function diffText(options) {
  const { cwd, staged, path: filePath, maxChars = 20_000, token, signal } = options
  const args = ['--no-pager', 'diff', '--no-color', '--unified=3']
  if (staged) args.push('--cached')
  if (filePath) args.push('--', filePath)
  const result = await runGit(args, { cwd, token, signal })
  const text = result.stdout
  return {
    result,
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符）` : text,
    truncated: text.length > maxChars,
  }
}

/**
 * git log 的紧凑列表。
 * @param {{cwd: string, limit?: number, path?: string, token?: string, signal?: AbortSignal}} options
 */
export async function logEntries(options) {
  const { cwd, limit = 20, path: filePath, token, signal } = options
  const args = ['log', `-n${Math.max(1, Math.min(limit, 200))}`, '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short']
  if (filePath) args.push('--', filePath)
  const result = await runGit(args, { cwd, token, signal })
  if (!result.ok) return { entries: [], result }
  const entries = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, author, date, ...rest] = line.split('\t')
      return { sha, author, date, subject: rest.join('\t') }
    })
  return { entries, result }
}

/** 分支列表。 */
export async function branches(cwd, options = {}) {
  const result = await runGit(['branch', '--no-color', '--format=%(refname:short)%09%(HEAD)'], { cwd, ...options })
  if (!result.ok) return { entries: [], result }
  const entries = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, head] = line.split('\t')
      return { name, current: head?.trim() === '*' }
    })
  return { entries, result }
}

/** 暂存若干路径。 */
export async function stage(cwd, paths, options = {}) {
  return runGit(['add', '--', ...paths], { cwd, ...options })
}

/** 提交（作者信息走 -c，不污染用户全局配置）。 */
export async function commit(cwd, message, options = {}) {
  const { author, ...rest } = options
  const args = ['-c', 'commit.gpgsign=false']
  if (author?.name) args.push('-c', `user.name=${author.name}`)
  if (author?.email) args.push('-c', `user.email=${author.email}`)
  args.push('commit', '-m', message)
  return runGit(args, { cwd, ...rest })
}

/** push 到 origin 的指定分支。 */
export async function push(cwd, options = {}) {
  const { branch, setUpstream, force, ...rest } = options
  const args = ['push']
  if (setUpstream) args.push('-u')
  if (force) args.push('--force-with-lease')
  args.push('origin')
  if (branch) args.push(branch)
  return runGit(args, { cwd, timeoutMs: 300_000, ...rest })
}

/** pull（默认 --ff-only，避免把冲突丢给模型）。 */
export async function pull(cwd, options = {}) {
  const { rebase, ...rest } = options
  const args = ['pull']
  args.push(rebase ? '--rebase' : '--ff-only')
  return runGit(args, { cwd, timeoutMs: 300_000, ...rest })
}
