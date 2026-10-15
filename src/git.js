/**
 * dsh-plugin-github — Git execution layer
 *
 * Pure Node.js implementation with no dependency on any DSH-internal package, so it is
 * easy to test on its own.
 * Every git subprocess goes through runProcess(), which handles, in one place:
 *   - arguments passed as an array (a shell string is never concatenated, so no injection)
 *   - timeouts and AbortSignal
 *   - stdout/stderr truncation
 *   - hiding the console window on Windows
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import path from 'node:path'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** Default timeout for a single git command. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Truncation cap (in characters) for stdout / stderr before it is returned to the model. */
export const MAX_OUTPUT_CHARS = 60_000

/**
 * Run an external process and collect its output.
 *
 * Why "temp files + file descriptors" instead of `stdio: ['pipe','pipe','pipe']`:
 * under the DSH file sandbox, Node's piped stdio relies on named pipes and the restricted
 * mode returns `spawn EPERM` outright (measured). Redirecting the child's stdout/stderr to
 * temp files uses nothing but file I/O, so it works in both the restricted and the
 * unrestricted mode, and it also avoids handing a string to a shell to interpret —
 * arguments are always passed as an array and never go through a shell, which makes
 * command injection structurally impossible.
 *
 * @param {string} command executable
 * @param {string[]} args argument array
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
    redact,
  } = options

  let scratch
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'dsh-gh-'))
  } catch (error) {
    return failure(`Cannot create a temp directory: ${message(error)}`)
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
    return failure(`Cannot create the output files: ${message(error)}`)
  }

  const result = await new Promise(resolve => {
    let stdinFd = -1
    if (input !== undefined) {
      try {
        stdinFd = openSync(stdinPath, 'r')
      } catch (error) {
        resolve({ kind: 'error', error: `Cannot open the stdin file: ${message(error)}` })
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
          /* the child process may have taken it over */
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
        /* the process may already have exited */
      }
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        // Key point: stdout/stderr go through file descriptors and stdin goes through a file,
        // so no named pipe is used anywhere.
        stdio: [stdinFd >= 0 ? stdinFd : 'ignore', outHandle.fd, errHandle.fd],
      })
    } catch (error) {
      done({ kind: 'error', error: `Cannot start ${command}: ${message(error)}` })
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

    child.on('error', error => done({ kind: 'error', error: `Process error: ${message(error)}` }))
    child.on('close', (code, closeSignal) => done({ kind: 'close', code, closeSignal }))
  })

  await outHandle.close().catch(() => {})
  await errHandle.close().catch(() => {})

  const stdout = await readCapped(outPath)
  const stderr = await readCapped(errPath)
  await rm(scratch, { recursive: true, force: true }).catch(() => {})

  const truncated = stdout.truncated || stderr.truncated
  // Scrub any known secret out of captured output before it can reach the model.
  // git should never echo a credential that arrived through the environment, but
  // "should never" is not a guarantee worth betting a token on: a failed
  // authentication can put the request back into an error message verbatim.
  const secrets = (redact ?? []).filter(secret => typeof secret === 'string' && secret.length >= 8)
  const scrub = value => {
    let text = value
    for (const secret of secrets) text = text.split(secret).join('[redacted]')
    return text
  }
  const base = {
    code: null, signal: null,
    stdout: scrub(stdout.text), stderr: scrub(stderr.text),
    truncated, timedOut: false, aborted: false,
  }

  if (result.kind === 'error') return { ...base, ok: false, error: scrub(result.error) }
  if (result.kind === 'aborted') {
    return { ...base, ok: false, aborted: true, signal: 'ABORTED', error: 'The call was cancelled (AbortSignal)' }
  }
  if (result.kind === 'timeout') {
    return {
      ...base, ok: false, timedOut: true, signal: 'TIMEOUT',
      error: `Command timed out (${timeoutMs}ms): ${scrub(`${command} ${args.join(' ')}`)}`,
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

/** Close a file descriptor that was opened synchronously. */
function closeSyncFd(fd) {
  closeSync(fd)
}

async function closeQuietly(...handles) {
  for (const handle of handles) {
    if (handle && typeof handle.close === 'function') await handle.close().catch(() => {})
  }
}

/** Read an output file and truncate it at the cap. */
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

/** Environment variables git needs in order to suppress interactive and certificate prompts. */
function gitEnv(token) {
  /** @type {Record<string, string>} */
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '0',
    // Never take git's optional locks. Refreshing the index would otherwise be able
    // to collide with whatever the user is doing in another terminal, and nothing
    // this plugin runs needs an optional lock.
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
  if (token) {
    // Not written into .git/config and not written into the command line: passed in only as
    // -c config for this single process.
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
  }
  return env
}

/**
 * The git executable to run. Defaults to `git` on PATH; a host whose git lives
 * somewhere unusual (a bundled runtime, a portable install) can point at it with
 * the `gitExecutable` config field instead of editing PATH.
 */
let gitExecutable = 'git'

/**
 * Point the plugin at a specific git executable.
 * @param {unknown} value
 * @returns {string} the executable now in effect
 */
export function setGitExecutable(value) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  // A control character here would come from a malformed config value; a command
  // containing one is never intended, so fall back to the default.
  gitExecutable = candidate !== '' && !/[\0\r\n]/.test(candidate) ? candidate : 'git'
  return gitExecutable
}

/** The git executable currently in effect. */
export function currentGitExecutable() {
  return gitExecutable
}

/**
 * Run a single git command.
 * @param {string[]} args
 * @param {{cwd?: string, token?: string, signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function runGit(args, options = {}) {
  const { cwd, token, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const result = await runProcess(gitExecutable, args, {
    cwd,
    env: gitEnv(token),
    signal,
    timeoutMs,
    // Belt and braces on top of the environment scrub: if git ever echoes the
    // credential (an authentication failure quoting the request), redact both the
    // raw token and the header value that carried it.
    redact: token
      ? [token, Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')]
      : [],
  })
  return { ...result, command: `git ${args.join(' ')}` }
}

/**
 * Check whether a path is a git working tree.
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
 * Turn the various shapes of repository identifier into an HTTPS clone URL.
 * Only `owner/repo` (and the bare git@ form) is completed into a github.com URL;
 * anything already using http(s):// or file:// is returned unchanged — otherwise local
 * clones and self-hosted services would be rewritten to github.com.
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

/** owner/repo form (with .git stripped); returns undefined when it cannot be recognized. */
export function repoSlug(repo) {
  const value = String(repo ?? '').trim()

  // For HTTP(S), parse with URL instead of a regex: the host may carry a port and the number
  // of path segments is not fixed, so a hand-written regex backtracks wrongly on
  // "host:port/owner/repo" (a mistake actually made here once).
  if (/^https?:\/\//i.test(value)) {
    const trailingHost = /^https?:\/\/[^/\s]+$/i.test(value)
    if (!trailingHost) {
      // Local test / self-hosted service case: a repository hangs directly off the host root
      // (the path has a single segment). Use the hostname as the owner, which keeps the
      // allowlist syntax owner/* usable.
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
 * Check whether an identifier is a local path (file:// or an absolute path).
 * Note that on Windows `path.isAbsolute('http://…')` returns true, so http(s) must be
 * excluded first.
 */
export function isLocalRepoRef(repo) {
  const value = String(repo ?? '').trim()
  if (/^https?:\/\//i.test(value)) return false
  return value.startsWith('file://') || path.isAbsolute(value)
}

/**
 * Local directory name (used when cloning).
 *
 * `<owner>__<repo>` rather than a bare `<repo>`: taking only the basename makes
 * `alice/tool` and `bob/tool` collide into the same directory and then push changes to the
 * wrong remote (found in review, D1).
 * Two underscores separate the parts, so the name cannot be confused with the legal
 * owner/repo character set (which allows a single underscore).
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
 * Read the origin URL of a local clone.
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
 * Read the URLs a local clone will **actually use when pushing**.
 *
 * Key point: `git remote get-url origin` returns the fetch URL, while `git push` prefers
 * `remote.<name>.pushurl`. Looking only at the fetch URL makes "the address authorization
 * checked" differ from "the address actually contacted" — a pushurl written into
 * .git/config is enough to send a PAT-bearing request to a different host.
 * @param {string} cwd
 * @param {{token?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<string[]>} all push URLs (deduplicated)
 */
export async function pushUrls(cwd, options = {}) {
  const result = await runGit(['remote', 'get-url', '--push', '--all', 'origin'], { cwd, ...options })
  if (!result.ok) return []
  return [...new Set(result.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
}

/**
 * Verify that a remote URL points at an allowed GitHub host.
 *
 * The allowlist rules constrain only `owner/repo`, never the host; and if the plugin's
 * token can be sent to any host at all, then "a slug from the allowlist appearing on an
 * attacker's domain" is a credential leak. Therefore:
 *   - canonical `owner/repo` always resolves to github.com (completed by remoteUrl)
 *   - forms that are already URLs allow only github.com / www.github.com
 *   - file:// and local paths never touch the network, so they are always allowed
 *   - a self-hosted Git service needs an explicit switch (allowNonGithubRemotes), because
 *     "any host is allowed" is the same as "credentials may be sent to any host"
 * @param {string} url
 * @param {boolean} [allowNonGithub]
 * @returns {string | undefined} the reason when it is not allowed
 */
export function assertAllowedHost(url, allowNonGithub = false) {
  const value = String(url ?? '').trim()
  if (value === '') return undefined
  if (allowNonGithub) return undefined
  if (/^file:\/\//i.test(value)) return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // No scheme: an ssh shorthand (git@host:path) or a local path
    const ssh = value.match(/^git@([^:\s]+):/i)
    if (ssh) return ssh[1].toLowerCase() === 'github.com' ? undefined : `Remote host ${ssh[1]} is not github.com`
    if (/^[A-Za-z]:[\\/]/.test(value) || path.isAbsolute(value)) return undefined
    return undefined
  }
  let host
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    return `Cannot parse the remote URL: ${value}`
  }
  if (host === 'github.com' || host === 'www.github.com') return undefined
  return `Remote host ${host} is not in the allowed list (only github.com is allowed).`
    + ' If you really need a self-hosted Git service, explicitly set allowNonGithubRemotes: true in the plugin config'
    + ' (note: that is the same as allowing credentials to be sent to any host you point it at).'
}

/**
 * Confirm that the origin of a local directory really is the repository that was requested.
 *
 * This is a key part of the authorization model: the allowlist validates `args.repo`, while
 * what is actually pushed/pulled is the origin inside the directory. If the two do not
 * match, the allowlist may have authorized a different repository (found in review, D1/D11).
 *
 * Deliberately written as a **synchronous function** (the caller reads the origin first and
 * passes it in): a throw inside a synchronous function is an ordinary exception in any
 * environment, whereas a throw inside an async function relies on the runtime propagating
 * the rejection correctly through the promise chain — measured on this machine's Node 24.19,
 * it escapes as a process-level unhandledRejection.
 *
 * @param {{actual: string | undefined, requested: string, dir: string, kind?: string, allowNonGithub?: boolean}} options
 * @returns {string} the actual origin URL
 * @throws {Error} when origin is missing, differs from the requested repository, or points at a disallowed host
 */
export function assertOriginMatches(options) {
  const { actual, requested, dir, kind = 'origin', allowNonGithub = false } = options
  if (actual === undefined || String(actual).trim() === '') {
    throw new Error(
      `Local directory ${dir} has no ${kind}, so it cannot be confirmed to be ${requested}.`
      + ' Delete that directory and run gh_repo action=clone again.',
    )
  }
  const hostProblem = assertAllowedHost(actual, allowNonGithub)
  if (hostProblem !== undefined) {
    throw new Error(
      `Refusing the operation: the ${kind} of local directory ${dir} is ${actual}, ${hostProblem}.`
      + ' Continuing would send credentials to an untrusted host.',
    )
  }
  const actualSlug = repoSlug(actual)
  const requestedSlug = repoSlug(requested)
  const same = actualSlug !== undefined && requestedSlug !== undefined
    ? actualSlug.toLowerCase() === requestedSlug.toLowerCase()
    : normalizeRemote(actual) === normalizeRemote(requested)
  if (!same) {
    throw new Error(
      `Refusing the operation: the ${kind} of local directory ${dir} is ${actual} (${actualSlug ?? 'unrecognized'}),`
      + ` while the request is for ${requested} (${requestedSlug ?? 'unrecognized'}).`
      + ' The directory contents do not match the requested repository, so continuing could push the changes to the wrong remote.'
      + ' Clone into a clean directory with gh_repo action=clone, or check the allowRepos and repo arguments.',
    )
  }
  return actual
}

/** Normalize a remote URL for comparison: strip the trailing slashes and .git, and lowercase. */
export function normalizeRemote(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
}

/**
 * Clone (or reuse an existing local clone). When it already exists and is a git repository,
 * only a fetch is done.
 * @param {{repo: string, dir: string, token?: string, signal?: AbortSignal, depth?: number}} options
 */
export async function cloneOrFetch(options) {
  const { repo, dir, token, signal, depth } = options
  // remoteUrl is now idempotent for every shape: owner/repo → github, URL/local path as-is.
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
  // The working copy must not depend on the operator's git configuration for line
  // endings. Windows git defaults `core.autocrlf` to `true`, which rewrites every
  // checked-out file to CRLF: this plugin then reports line numbers, diffs and
  // exact-match search against CRLF text, while any file the tool writes is LF —
  // so an edit that works on one machine fails on a clean one. A repository's own
  // `.gitattributes` still wins, because git applies it after this setting.
  args.push('-c', 'core.autocrlf=false')
  args.push(target, dir)
  const result = await runGit(args, { token, signal, timeoutMs: 300_000 })
  return { reused: false, result }
}

/** Short sha and commit subject of the current HEAD. */
export async function headCommit(cwd, options = {}) {
  const result = await runGit(['log', '-1', '--pretty=format:%h%x09%s'], { cwd, ...options })
  if (!result.ok) return undefined
  const [sha, ...rest] = result.stdout.split('\t')
  return { sha: sha.trim(), subject: rest.join('\t').trim() }
}

/**
 * Parse git status --porcelain=v1 -uall.
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
 * Read one diff.
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
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated, ${text.length} characters in total)` : text,
    truncated: text.length > maxChars,
  }
}

/**
 * Compact list from git log.
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

/** Branch list. */
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

/** Stage a set of paths. */
export async function stage(cwd, paths, options = {}) {
  return runGit(['add', '--', ...paths], { cwd, ...options })
}

/** Commit (author information goes through -c, so the user's global config is not polluted). */
export async function commit(cwd, message, options = {}) {
  const { author, ...rest } = options
  const args = ['-c', 'commit.gpgsign=false']
  if (author?.name) args.push('-c', `user.name=${author.name}`)
  if (author?.email) args.push('-c', `user.email=${author.email}`)
  args.push('commit', '-m', message)
  return runGit(args, { cwd, ...rest })
}

/** Push to the given branch on origin. */
export async function push(cwd, options = {}) {
  const { branch, setUpstream, force, ...rest } = options
  const args = ['push']
  if (setUpstream) args.push('-u')
  if (force) args.push('--force-with-lease')
  args.push('origin')
  if (branch) args.push(branch)
  return runGit(args, { cwd, timeoutMs: 300_000, ...rest })
}

/** pull (defaults to --ff-only, so conflicts are not dumped on the model). */
export async function pull(cwd, options = {}) {
  const { rebase, ...rest } = options
  const args = ['pull']
  args.push(rebase ? '--rebase' : '--ff-only')
  return runGit(args, { cwd, timeoutMs: 300_000, ...rest })
}
