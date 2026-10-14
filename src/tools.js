/**
 * dsh-plugin-github — tool definition layer
 *
 * Describes only the shape and implementation of the tools; it does not care how they are
 * registered: every ToolSpec provides name / description / parameters / execute.
 * index.js turns these declarations into the ToolDefinition that dsh-tools needs and registers them.
 */

import path from 'node:path'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import {
  assertOriginMatches,
  branches,
  cloneOrFetch,
  commit as gitCommit,
  diffText,
  headCommit,
  isGitRepo,
  isLocalRepoRef,
  logEntries,
  originUrl,
  pull as gitPull,
  push as gitPush,
  pushUrls,
  repoSlug,
  stage,
  statusEntries,
} from './git.js'
import { checkWriteAllowed, ensureInsideWorkspace, repoAllowed, resolveRepo, summarizeConfig } from './repos.js'
import { clearToken, describeToken, resolveToken, storeToken } from './auth.js'
import { askForToken, unboundMessage } from './prompt.js'
import { accountView, describeAccount } from './store.js'
import { githubRequest } from './api.js'

/**
 * Validate **every** remote address a push may use.
 *
 * `assertOriginMatches` only looks at the fetch URL, whereas `git push` prefers
 * `remote.origin.pushurl`. Validating only the former lets "the authorized address" and
 * "the address actually contacted" diverge: a pushurl written into .git/config is enough
 * to send the PAT-carrying request to a different host (found in audit D3).
 * @param {import('./repos.js').PluginConfig} cfg
 * @param {{dir: string, slug: string, token?: string, signal?: AbortSignal}} options
 */
async function assertPushTargetsTrusted(cfg, options) {
  const { dir, slug, token, signal } = options
  const targets = await pushUrls(dir, { token, signal })
  const allowNonGithub = cfg.allowNonGithubRemotes === true
  if (targets.length === 0) {
    // When there is no explicit pushurl, git uses the fetch URL, which must still be validated.
    assertOriginMatches({ dir, requested: slug, actual: await originUrl(dir, { token, signal }), kind: 'origin', allowNonGithub })
    return
  }
  for (const target of targets) {
    assertOriginMatches({ dir, requested: slug, actual: target, kind: `push target ${target}`, allowNonGithub })
  }
}

const text = value => [{ type: 'text', text: value }]

/** Truncate long text (also reporting the original length so the model cannot misjudge completeness). */
function cap(value, max) {
  const textValue = String(value ?? '')
  if (textValue.length <= max) return textValue
  return `${textValue.slice(0, max)}\n…(truncated: ${textValue.length} characters total, limit ${max})`
}

/**
 * Recursively delete `undefined` properties from an object.
 *
 * The host validates output with a "lossless JSON" check: `JSON.stringify` drops
 * `undefined` properties, so `{ ok: true, x: undefined }` no longer matches the value seen
 * before validation and the whole tool call fails with `value is not lossless JSON`
 * (actually hit in the real host). Every optional field must therefore be stripped here
 * rather than left on the object.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return /** @type {T} */ (value.map(pruneUndefined).filter(item => item !== undefined))
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = pruneUndefined(item)
    }
    return /** @type {T} */ (out)
  }
  return value
}

/**
 * Resolve the token and normalize it into a shape that is safe to put in a tool return value.
 *
 * `ResolvedCredential.value` is a secret and must never reach any tool return value — keep
 * only the source and configuration state at the source, so the whole object can never leak
 * out by accident.
 */
async function tokenFacts(context, cfg, cwd) {
  const resolved = await resolveToken({
    accounts: context.host.accounts,
    credentials: context.host.credentials,
    tokenRef: cfg.tokenRef,
    tokenEnv: cfg.tokenEnv,
    dotenv: cfg.dotenv,
    cwd: cwd ?? cfg.workspaceRoot,
  })
  return {
    token: resolved.token,
    configured: resolved.configured,
    source: resolved.source ?? 'none',
    detail: resolved.detail,
  }
}

/** Uniform wrapper: every throw becomes a clear tool error. */
function fail(message) {
  const error = new Error(message)
  error.toolFailure = true
  return error
}

/**
 * Parse complex parameters passed in as JSON strings.
 * Strings are used instead of nested objects so as not to depend on the parameter DSL's
 * nested-object syntax; that is safe on both registration paths.
 * @param {unknown} raw
 * @param {string} name
 * @param {'object'|'array'} kind
 */
function parseJsonArg(raw, name, kind) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') throw fail(`${name} must be a JSON string.`)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (kind === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw fail(`${name} must be a JSON object, for example {"state":"open"}.`)
  }
  return parsed
}

/**
 * Normalize an API endpoint and extract the target repository (owner/repo).
 *
 * The path must be parsed only after normalizing with `new URL()`: authorization looks at
 * the raw string, while the request actually sent goes through URL normalization, so
 * `/repos/allowed/repo/../../secret/repo/issues` would be authorized as `allowed/repo` but
 * hit `secret/repo` (found in audit D1). After normalization, take `/repos/{owner}/{repo}`.
 *
 * @param {string} endpoint
 * @returns {{ pathname: string, host: string, repo?: string }}
 * @throws {Error} endpoint cannot be parsed, or points at a host other than api.github.com
 */
function parseEndpoint(endpoint) {
  const raw = String(endpoint).trim()
  const absolute = /^https?:\/\//i.test(raw)
  let url
  try {
    url = new URL(raw, 'https://api.github.com')
  } catch {
    throw fail(`endpoint cannot be parsed: "${raw}". Example: /repos/owner/repo/pulls.`)
  }
  if (absolute && url.hostname.toLowerCase() !== 'api.github.com') {
    throw fail(`For security, only api.github.com may be accessed (got ${url.origin}).`)
  }
  const pathname = url.pathname
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)/)
  let repo
  if (match) {
    const owner = match[1]
    const name = match[2].replace(/\.git$/i, '')
    if (owner !== '' && name !== '') repo = `${owner}/${name}`
  }
  return { pathname, host: url.hostname.toLowerCase(), repo }
}

/**
 * Which endpoint prefixes may touch repository content or state (these must not be waved
 * through by default when an allowlist exists).
 * Account/meta endpoints such as `/user` and `/rate_limit` are not repository content, so they pass.
 */
const REPO_SCOPED_PREFIXES = [
  '/repos/', '/search/', '/orgs/', '/users/', '/user/repos', '/user/subscriptions',
  '/user/starred', '/gists/', '/installation/', '/app/',
]


/**
 * Refuse to write .git internal files.
 *
 * `.git/config` can change `remote.origin.pushurl` (redirecting a PAT-carrying push to
 * another host), `.git/hooks/*` is arbitrary code execution, and `.git/HEAD` and friends
 * corrupt the repository outright. Reading is still allowed (some debugging needs to see
 * the config); writing is always refused.
 * @param {string} repoDir
 * @param {string} target
 * @param {string} relative
 */
function assertNotGitInternals(repoDir, target, relative) {
  const gitDir = path.join(repoDir, '.git')
  const rel = path.relative(gitDir, target)
  const insideGit = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (insideGit) {
    throw fail(
      `Refusing to modify ${relative}: the inside of the .git directory (config / hooks / HEAD, etc.) cannot be written through gh_file.`
      + ' .git/config can redirect the push address (sending credentials to another host), and .git/hooks is arbitrary code execution.',
    )
  }
}

/**
 * @typedef {object} ToolContext
 * @property {import('./repos.js').PluginConfig} config
 * @property {{credentials?: unknown, agents?: {currentInitiator?: () => unknown}} } host
 */

/**
 * Build every tool definition.
 * @param {ToolContext} context
 */
export function buildToolSpecs(context) {
  const cfg = context.config
  const accounts = context.host.accounts
  const userQuestions = context.host.userQuestions

  /** Resolve the token (re-resolved on every call, so switching accounts or rotating credentials takes effect immediately). */
  const token = async cwd => resolveToken({
    accounts,
    credentials: context.host.credentials,
    tokenRef: cfg.tokenRef,
    tokenEnv: cfg.tokenEnv,
    dotenv: cfg.dotenv,
    cwd: cwd ?? cfg.workspaceRoot,
  })

  /**
   * Every operation that needs credentials goes through here:
   *   1. resolve in the normal order first;
   *   2. if it does not resolve and this is a call a human can interact with → prompt the
   *      binding guide, and retry immediately after binding;
   *   3. still nothing → throw an error carrying actionable guidance.
   *
   * @param {string} reason why credentials are needed (used in the guidance text)
   * @param {{cwd?: string, exec?: any}} [options]
   */
  const requireToken = async (reason, options = {}) => {
    const first = await token(options.cwd)
    // A credential that is already explicitly in effect (bound account / credentials service / non-fallback path) is used as is.
    if (first.configured && first.viaEnvFallback !== true) return first

    // Whether the user can be asked is the only gate for "should the binding guide pop up".
    // When interaction is unavailable (subagent, UI-less runtime, disabled by config) do
    // **not** block: let the operation through as before and let the remote decide the
    // outcome — that way local/intranet remotes that need no credentials still work.
    const interactive = cfg.allowAutoBind !== false
      && cfg.promptForToken !== false
      && userQuestions !== undefined
      && accounts !== undefined
      && options.exec?.agent !== undefined

    if (!interactive) return first

    const asked = await askForToken({
      userQuestions,
      agent: options.exec.agent,
      signal: options.exec.signal,
      reason,
    })

    if (asked.status === 'answered') {
      const bound = await accounts.bind(asked.token, { source: 'gh_account bind (entered in conversation)' })
      const retried = await token(options.cwd)
      if (retried.configured) {
        return { ...retried, detail: `${retried.detail} (just bound @${bound.login})`, justBound: bound.login }
      }
    }

    if (asked.status === 'skipped') {
      // The user skipped deliberately: respect that choice and let the operation continue as before.
      return first
    }

    // Interaction is unavailable, but an environment variable provides a fallback → use it.
    if (first.configured) return first
    throw fail(unboundMessage(asked.detail))
  }

  // ---------------------------------------------------------------- gh_repo
  const repoAction = {
    clone: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo, { requireLocal: false })
      // The allowlist must be checked against "the repository that will actually be operated on", not some other derived string.
      if (!repoAllowed(cfg, slug)) {
        throw fail(`Repository ${slug} is not in the allowRepos allowlist (current: ${cfg.allowRepos.join(', ')}).`)
      }
      // If the directory already exists, origin must be exactly the requested repository: otherwise fetch would pull from a different remote.
      if (await isGitRepo(dir)) {
        assertOriginMatches({ dir, requested: slug, actual: await originUrl(dir, { signal: exec.signal }), allowNonGithub: cfg.allowNonGithubRemotes === true })
      }
      const auth = await token(cfg.workspaceRoot)
      const isLocal = isLocalRepoRef(String(args.repo))
      const { reused, result } = await cloneOrFetch({
        repo: args.repo,
        dir,
        remote: isLocal ? String(args.repo) : undefined,
        token: auth.token,
        signal: exec.signal,
        depth: args.depth,
      })
      if (!result.ok) {
        throw fail(
          `${reused ? 'fetch' : 'clone'} failed: ${result.error ?? (result.stderr || 'unknown error')}\n`
          + `Target directory: ${dir}\n`
          + (auth.configured ? '' : `Hint: no token is configured (${auth.detail}). Private repositories need a token; public repositories should configure one too, to avoid rate limiting.`),
        )
      }
      const head = await headCommit(dir, { signal: exec.signal })
      return pruneUndefined({
        ok: true,
        action: reused ? 'fetch' : 'clone',
        path: dir,
        repo: slug,
        head,
        auth: auth.configured ? auth.source : 'anonymous',
        note: reused ? 'The repository already exists locally; only fetch --prune was run' : 'Clone complete',
        output: cap(result.stderr || result.stdout, 4000),
      })
    },

    status: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const { entries, result } = await statusEntries(dir, { signal: exec.signal })
      if (!result.ok) {
        throw fail(`git status failed (${dir} may not be a valid git repository): ${result.error ?? (result.stderr || result.stdout)}`)
      }
      const head = await headCommit(dir, { signal: exec.signal })
      const origin = await originUrl(dir, { signal: exec.signal })
      // head/origin can both be undefined (empty repository, no remote): they must be stripped out rather than left in the return value.
      return pruneUndefined({
        ok: true,
        action: 'status',
        repo: slug,
        path: dir,
        head,
        origin,
        clean: entries.length === 0,
        changed: entries.length,
        files: entries.slice(0, 200),
        truncated: entries.length > 200,
      })
    },

    diff: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const staged = args.staged === true
      const { text: body, truncated } = await diffText({
        cwd: dir,
        staged,
        path: args.file,
        maxChars: cfg.maxDiffChars,
        signal: exec.signal,
      })
      return pruneUndefined({
        ok: true,
        action: 'diff',
        repo: slug,
        staged,
        file: args.file,
        truncated,
        diff: body === '' ? '(no differences)' : body,
      })
    },

    log: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const requested = Number.isFinite(args.limit) ? Number(args.limit) : 20
      const limit = Math.max(1, Math.min(requested, 200))
      const { entries, result } = await logEntries({
        cwd: dir, limit, path: args.file, signal: exec.signal,
      })
      if (!result.ok) {
        throw fail(`git log failed: ${result.error ?? (result.stderr || result.stdout)}`)
      }
      return { ok: true, action: 'log', repo: slug, limit, count: entries.length, commits: entries }
    },

    branches: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const { entries, result } = await branches(dir, { signal: exec.signal })
      if (!result.ok) {
        throw fail(`git branch failed: ${result.error ?? (result.stderr || result.stdout)}`)
      }
      return { ok: true, action: 'branches', repo: slug, branches: entries }
    },

    create: async (args, exec) => {
      // Creating a remote repository is a write: allowApiWrite must be explicitly enabled, and owner/name must pass the allowlist.
      if (!cfg.allowApiWrite) {
        throw fail('action=create refused: allowApiWrite is configured as false (creating a remote repository is a write operation).')
      }
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw fail('action=create requires the name parameter (the new repository name).')
      }
      const newName = args.name.trim()
      if (!/^[A-Za-z0-9._-]+$/.test(newName)) {
        throw fail(`Repository name "${args.name}" is invalid: only letters, digits, dots, underscores and hyphens are allowed.`)
      }
      const ownerScoped = typeof args.owner === 'string' && args.owner.trim() !== ''
      const owner = ownerScoped ? args.owner.trim() : undefined
      if (owner !== undefined && !/^[A-Za-z0-9._-]+$/.test(owner)) {
        throw fail(`owner "${args.owner}" is invalid: only letters, digits, dots, underscores and hyphens are allowed.`)
      }
      if (owner !== undefined && !repoAllowed(cfg, `${owner}/${newName}`)) {
        throw fail(`Target ${owner}/${newName} is not in the allowRepos allowlist; refusing to create it.`)
      }
      if (owner === undefined && cfg.allowRepos.length > 0) {
        // Without owner the repository is created under "the currently signed-in account",
        // which cannot be compared against the allowlist — an unjudgeable target must not be allowed through.
        throw fail(
          'While the allowRepos allowlist is in effect, action=create must give owner explicitly (otherwise the target account cannot be compared against the allowlist).'
          + ' Pass owner: "your-name".',
        )
      }
      const auth = await requireToken('Creating a remote repository requires write permission.', { cwd: cfg.workspaceRoot, exec })
      const endpoint = owner !== undefined ? `/orgs/${owner}/repos` : '/user/repos'
      const response = await githubRequest(endpoint, {
        method: 'POST',
        token: auth.token,
        signal: exec.signal,
        body: {
          name: newName,
          description: typeof args.description === 'string' ? args.description : undefined,
          private: args.private === true,
          auto_init: true,
        },
      })
      if (!response.ok) {
        // GitHub returns 401/403 when credentials are missing: spell out the "go bind an
        // account" step instead of throwing a bare HTTP error at the user.
        if (response.status === 401 || response.status === 403) {
          throw fail(
            `Failed to create the repository (HTTP ${response.status}): ${response.error ?? 'authentication failed'}\n`
            + unboundMessage(auth.detail),
          )
        }
        throw fail(response.error ?? 'Failed to create the repository')
      }
      const created = /** @type {{full_name?: string, html_url?: string, clone_url?: string}} */ (response.json ?? {})
      return {
        ok: true,
        action: 'create',
        repo: created.full_name,
        url: created.html_url,
        clone_url: created.clone_url,
        note: `Remote repository created. Use gh_repo action=clone repo="${created.full_name}" to clone it into the workspace.`,
      }
    },
  }

  // ---------------------------------------------------------------- gh_file
  const fileAction = {
    get: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const target = await ensureInsideWorkspace(cfg, path.resolve(dir, args.path))
      const relative = path.relative(dir, target).split(path.sep).join('/')
      const startLine = Number.isFinite(args.startLine) ? Math.max(1, Number(args.startLine)) : 1
      const endLine = Number.isFinite(args.endLine) ? Math.max(startLine, Number(args.endLine)) : undefined

      let content
      try {
        content = await readFile(target, 'utf8')
      } catch (error) {
        throw fail(`Failed to read ${relative}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const allLines = content.split('\n')
      const from = Math.min(startLine, allLines.length)
      const to = endLine === undefined ? Math.min(from + 400 - 1, allLines.length) : Math.min(endLine, allLines.length)
      const window = allLines.slice(from - 1, to)
      const numbered = window.map((line, index) => `${String(from + index).padStart(6)}│ ${line}`).join('\n')
      return {
        ok: true,
        action: 'get',
        repo: slug,
        path: relative,
        totalLines: allLines.length,
        from,
        to,
        returnedLines: window.length,
        // Only report truncation when content was genuinely left out: reaching the end of the file must not be flagged.
        truncated: from > 1 || to < allLines.length,
        content: cap(numbered, cfg.maxReadChars),
      }
    },

    list: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const target = await ensureInsideWorkspace(cfg, path.resolve(dir, args.path ?? '.'))
      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch (error) {
        throw fail(`Failed to list directory ${args.path ?? '.'}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const bypassed = new Set(['node_modules', '.venv', 'dist', 'build', '__pycache__'])
      const listed = []
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const full = path.join(target, entry.name)
        let size
        if (entry.isFile()) {
          try {
            size = (await stat(full)).size
          } catch {
            size = undefined
          }
        }
        listed.push(pruneUndefined({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size,
          ignored: bypassed.has(entry.name),
        }))
      }
      listed.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      return {
        ok: true,
        action: 'list',
        repo: slug,
        path: args.path ?? '.',
        count: listed.length,
        entries: listed.slice(0, 500),
        truncated: listed.length > 500,
      }
    },

    put: async (args, exec) => {
      if (typeof args.content !== 'string') throw fail('action=put requires the content parameter.')
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const target = await ensureInsideWorkspace(cfg, path.resolve(dir, args.path))
      const relative = path.relative(dir, target).split(path.sep).join('/')
      assertNotGitInternals(dir, target, relative)
      let existed = false
      try {
        existed = (await stat(target)).isFile()
      } catch {
        existed = false
      }
      if (existed && args.overwrite !== true) {
        throw fail(
          `${relative} already exists. To overwrite it entirely set overwrite: true; for a partial change use gh_file action=edit.`,
        )
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, args.content, 'utf8')
      return {
        ok: true,
        action: 'put',
        repo: slug,
        path: relative,
        bytes: Buffer.byteLength(args.content, 'utf8'),
        created: !existed,
        note: existed ? 'Overwritten' : 'File created',
      }
    },

    edit: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const target = await ensureInsideWorkspace(cfg, path.resolve(dir, args.path))
      const relative = path.relative(dir, target).split(path.sep).join('/')
      assertNotGitInternals(dir, target, relative)
      let original
      try {
        original = await readFile(target, 'utf8')
      } catch (error) {
        throw fail(`Failed to read ${relative}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (typeof args.oldText !== 'string' || args.oldText === '') {
        throw fail('action=edit requires a non-empty oldText.')
      }
      if (typeof args.newText !== 'string') throw fail('action=edit requires newText (an empty string means delete).')

      const parts = original.split(args.oldText)
      const occurrences = parts.length - 1
      const expected = Number.isFinite(args.count) ? Number(args.count) : 1
      if (expected < 1) throw fail(`count must be ≥ 1, got ${args.count}.`)
      if (occurrences === 0) {
        throw fail(`oldText was not found in ${relative}. Use gh_file action=get first to confirm the exact original text (mind the indentation and line breaks).`)
      }
      if (occurrences !== expected) {
        throw fail(
          `oldText appears ${occurrences} time(s) in ${relative}, which does not match count=${expected}.`
          + ' Widen the context so oldText is unique, or use count to state exactly how many replacements you want.',
        )
      }
      const updated = parts.join(args.newText)
      await writeFile(target, updated, 'utf8')
      return {
        ok: true,
        action: 'edit',
        repo: slug,
        path: relative,
        replacements: occurrences,
        linesBefore: original.split('\n').length,
        linesAfter: updated.split('\n').length,
      }
    },
  }

  // ---------------------------------------------------------------- gh_commit
  const commitTool = async (args, exec) => {
    const { dir, slug } = await resolveRepo(cfg, args.repo)
    const before = await headCommit(dir, { signal: exec.signal })

    const paths = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths.map(String) : ['.']
    const addResult = await stage(dir, paths, { signal: exec.signal, timeoutMs: cfg.commandTimeoutMs })
    if (!addResult.ok) {
      throw fail(`git add failed: ${addResult.error ?? (addResult.stderr || addResult.stdout)}\n(paths: ${paths.join(', ')})`)
    }

    const { entries } = await statusEntries(dir, { signal: exec.signal })
    const stagedEntries = entries.filter(entry => entry.code !== '??')
    if (stagedEntries.length === 0) {
      throw fail(
        'The staging area is empty; there is nothing to commit.'
        + ' (The path may be wrong, or the changes are ignored; check with gh_repo action=status.)',
      )
    }

    const commitResult = await gitCommit(dir, args.message, {
      signal: exec.signal,
      timeoutMs: cfg.commandTimeoutMs,
      author: {
        name: args.authorName ?? cfg.gitAuthorName,
        email: args.authorEmail ?? cfg.gitAuthorEmail,
      },
    })
    if (!commitResult.ok) {
      throw fail(`git commit failed: ${commitResult.error ?? (commitResult.stderr || commitResult.stdout)}`)
    }
    const after = await headCommit(dir, { signal: exec.signal })

    let pushed
    if (args.push === true) {
      const denied = checkWriteAllowed(cfg, slug, 'push')
      if (denied) throw fail(`${denied}\n(The commit is already made locally: ${after?.sha}, but nothing was pushed.)`)
      const auth = await requireToken('Pushing the commit to the remote requires write permission.', { cwd: dir, exec })
      await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
      const pushResult = await gitPush(dir, { token: auth.token, signal: exec.signal, setUpstream: true })
      if (!pushResult.ok) {
        throw fail(
          `Committed locally as ${after?.sha}, but the push failed: ${pushResult.error ?? (pushResult.stderr || pushResult.stdout)}\n`
          + ' (Check with gh_repo action=status, then call gh_push to retry the push on its own.)',
        )
      }
      pushed = { ok: true, output: cap(pushResult.stderr || pushResult.stdout, 4000) }
    }

    return pruneUndefined({
      ok: true,
      action: 'commit',
      repo: slug,
      previousHead: before,
      head: after,
      stagedFiles: stagedEntries.map(entry => `${entry.code} ${entry.path}`),
      pushed: pushed ?? false,
      pushOutput: pushed?.output,
    })
  }

  // ---------------------------------------------------------------- gh_push
  const pushTool = async (args, exec) => {
    // Check the allowlist before touching local paths: an unauthorized repository must not leak local layout information just because "the directory does not exist".
    const requestedSlug = repoSlug(String(args.repo)) ?? String(args.repo)
    const denied = checkWriteAllowed(cfg, requestedSlug, 'push')
    if (denied) throw fail(denied)
    const { dir, slug } = await resolveRepo(cfg, args.repo)
    const auth = await requireToken('Pushing to the remote requires write permission.', { cwd: dir, exec })
    // The allowlist validates args.repo, but the actual push target is origin in the directory — the two must agree.
    await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
    if (args.force === true && !cfg.allowForcePush) {
      throw fail('Force push refused: allowForcePush is configured as false. (Even when enabled, only --force-with-lease is used.)')
    }
    const before = await headCommit(dir, { signal: exec.signal })
    // Without a token, do not refuse outright: local/intranet remotes may genuinely need no
    // credentials, so let the remote decide and give an actionable "configure a token" hint only on failure.
    const result = await gitPush(dir, {
      token: auth.token,
      signal: exec.signal,
      branch: args.branch,
      setUpstream: args.branch !== undefined,
      force: args.force === true,
    })
    if (!result.ok) {
      const unauthenticated = /Authentication failed|could not read Username|terminal prompts disabled|403/i
        .test(`${result.stderr}${result.stdout}`)
      const hint = unauthenticated && !auth.configured
        ? `\nNo usable credential is available right now (${auth.detail}). Use gh_config action=set to store a PAT, or set the environment variable ${cfg.tokenEnv}.`
        : 'Common causes: the remote has new commits (run gh_pull first); branch protection forbids a direct push (use a PR flow instead); the token lacks repo permission.'
      throw fail(`Push failed: ${result.error ?? (result.stderr || result.stdout)}\n${hint}`)
    }
    return {
      ok: true,
      action: 'push',
      repo: slug,
      head: before,
      branch: args.branch ?? '(current branch → same-named remote branch)',
      force: args.force === true,
      output: cap(result.stderr || result.stdout, 4000),
    }
  }

  // ---------------------------------------------------------------- gh_pull
  const pullTool = async (args, exec) => {
    const { dir, slug } = await resolveRepo(cfg, args.repo)
    const auth = await requireToken('Pulling remote changes requires credentials.', { cwd: dir, exec })
    // A pull rewrites local history, so it likewise requires origin to match the requested repository.
    await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
    const before = await headCommit(dir, { signal: exec.signal })
    const result = await gitPull(dir, {
      token: auth.token,
      signal: exec.signal,
      rebase: args.rebase === true,
    })
    if (!result.ok) {
      const hint = /diverg|non-fast-forward|Not possible to fast-forward/i.test(`${result.stderr}${result.stdout}`)
        ? '\nLocal and remote have diverged. Options: retry with rebase: true, or gh_commit the local changes first and then deal with it.'
        : ''
      throw fail(`Pull failed: ${result.error ?? (result.stderr || result.stdout)}${hint}`)
    }
    const after = await headCommit(dir, { signal: exec.signal })
    return {
      ok: true,
      action: 'pull',
      repo: slug,
      before,
      after,
      changed: before?.sha !== after?.sha,
      output: cap(result.stderr || result.stdout, 4000),
    }
  }

  // ---------------------------------------------------------------- gh_config
  const configTool = async args => {
    if (args.action === 'set') {
      if (typeof args.token !== 'string' || args.token.trim() === '') {
        throw fail('action=set requires the token parameter (a GitHub Personal Access Token).')
      }
      const stored = await storeToken({ credentials: context.host.credentials, tokenRef: cfg.tokenRef }, args.token)
      if (!stored.ok) throw fail(stored.detail)
      const after = await resolveToken({
        credentials: context.host.credentials, tokenRef: cfg.tokenRef, tokenEnv: cfg.tokenEnv, dotenv: false,
      })
      return { ok: true, action: 'set', detail: stored.detail, effective_source: after.source }
    }
    if (args.action === 'unset') {
      const cleared = await clearToken({ credentials: context.host.credentials, tokenRef: cfg.tokenRef })
      if (!cleared.ok) throw fail(cleared.detail)
      return { ok: true, action: 'unset', detail: cleared.detail }
    }
    const status = await describeToken({
      credentials: context.host.credentials,
      tokenRef: cfg.tokenRef,
      tokenEnv: cfg.tokenEnv,
      dotenv: cfg.dotenv,
      cwd: cfg.workspaceRoot,
    })
    const current = await tokenFacts(context, cfg, cfg.workspaceRoot)
    let identity
    if (current.token) {
      const who = await githubRequest('/user', { token: current.token })
      identity = who.ok
        ? pruneUndefined({
            ok: true,
            login: /** @type {{login?: string}} */ (who.json ?? {}).login,
            scopes: who.headers['x-oauth-scopes'],
            rate_remaining: who.rateLimit?.remaining,
          })
        : { ok: false, error: who.error ?? 'request failed' }
    }
    return pruneUndefined({
      ok: true,
      action: 'status',
      ...status,
      identity,
      config_summary: summarizeConfig(cfg, {
        configured: status.configured, source: status.effective_source,
      }),
    })
  }

  // ---------------------------------------------------------------- gh_account
  /**
   * Account binding tool. This is the user's explicit entry point for "which GitHub
   * account to bind", and also where the automatic first-use guidance lands.
   */
  const accountTool = async (args, exec) => {
    if (accounts === undefined) {
      throw fail(
        'Account storage is unavailable, so account bindings cannot be managed.'
        + ` Instead, write ${cfg.tokenRef} into the refs: section of $DSH_HOME/.credentials.yaml, or set the environment variable ${cfg.tokenEnv}.`,
      )
    }

    if (args.action === 'list') {
      const records = await accounts.list()
      const activeId = await accounts.activeId()
      return pruneUndefined({
        ok: true,
        action: 'list',
        backend: accounts.backend,
        active: activeId,
        count: records.length,
        accounts: records.map(record => accountView(record, activeId)),
        hint: records.length === 0
          ? 'No account is bound yet. Bind one with action=bind (a prompt appears, or pass the token in directly).'
          : 'Use action=use to switch the default account.',
      })
    }

    if (args.action === 'bind') {
      let token = typeof args.token === 'string' && args.token.trim() !== '' ? args.token.trim() : undefined
      let fromPrompt = false

      if (token === undefined) {
        // No token passed directly: prompt the binding guide first.
        const asked = await askForToken({
          userQuestions,
          agent: exec?.agent,
          signal: exec?.signal,
          reason: 'Binding a GitHub account requires your Personal Access Token.',
        })
        if (asked.status === 'answered') {
          token = asked.token
          fromPrompt = true
        } else if (asked.status === 'unavailable') {
          // A token in an environment variable also counts as a binding (it is simply not written to disk).
          const fromHost = context.host.envToken?.value
          const fromProcess = process.env[cfg.tokenEnv] ?? process.env.GITHUB_TOKEN
          const envToken = typeof fromHost === 'string' && fromHost !== '' ? fromHost : fromProcess
          if (typeof envToken === 'string' && envToken.trim() !== '') {
            token = envToken.trim()
          } else {
            throw fail(
              `${asked.detail}\n`
              + 'Instead: pass the token to gh_account action=bind through the token parameter; '
              + 'or write '
              + `${cfg.tokenRef} yourself into the refs: section of $DSH_HOME/.credentials.yaml; or set the environment variable ${cfg.tokenEnv}.`,
            )
          }
        } else {
          throw fail('Binding cancelled. Call gh_account action=bind again when you need it.')
        }
      }

      const bound = await accounts.bind(token, {
        source: fromPrompt ? 'gh_account bind (entered in conversation)' : 'gh_account bind (token parameter)',
      })
      return pruneUndefined({
        ok: true,
        action: 'bind',
        backend: accounts.backend,
        active: bound.id,
        account: accountView(bound, bound.id),
        note: `Bound and set as the default account @${bound.login}. All later gh_* calls use this account by default.`,
        security_note: fromPrompt
          ? 'The token was entered through the conversation, so it appears in this session transcript. If you do not want that, provide it from a credentials file or an environment variable instead, then remove the current binding and bind again.'
          : undefined,
      })
    }

    if (args.action === 'use') {
      if (typeof args.login !== 'string' || args.login.trim() === '') {
        throw fail('action=use requires the login parameter (a login name or account id).')
      }
      const record = await accounts.use(args.login)
      return pruneUndefined({
        ok: true,
        action: 'use',
        backend: accounts.backend,
        active: record.id,
        account: accountView(record, record.id),
        note: `Default account switched to @${record.login}.`,
      })
    }

    if (args.action === 'remove') {
      if (typeof args.login !== 'string' || args.login.trim() === '') {
        throw fail('action=remove requires the login parameter (a login name or account id).')
      }
      const removed = await accounts.remove(args.login)
      const activeId = await accounts.activeId()
      return pruneUndefined({
        ok: true,
        action: 'remove',
        backend: accounts.backend,
        removed: removed.id,
        active: activeId,
        note: removed.wasActive
          ? 'Account removed; it was the default account, so another one must be specified or bound the next time credentials are needed.'
          : 'Account removed.',
      })
    }

    // Default action=status
    const current = await tokenFacts(context, cfg, cfg.workspaceRoot)
    const activeRecord = await accounts.active()
    const all = await accounts.list()
    const activeId = await accounts.activeId()

    let identity
    if (current.token) {
      const who = await githubRequest('/user', { token: current.token })
      identity = who.ok
        ? pruneUndefined({
            ok: true,
            login: /** @type {{login?: string}} */ (who.json ?? {}).login,
            name: /** @type {{name?: string}} */ (who.json ?? {}).name,
            scopes: who.headers['x-oauth-scopes'],
            rate_remaining: who.rateLimit?.remaining,
          })
        : { ok: false, error: who.error ?? 'request failed' }
    }
    return pruneUndefined({
      ok: true,
      action: 'status',
      backend: accounts.backend,
      bound: all.length,
      active: activeId,
      active_account: activeRecord === undefined ? undefined : accountView(activeRecord, activeId),
      credential_source: current.source,
      configured: current.configured,
      identity,
      accounts: all.map(record => accountView(record, activeId)),
      hint: all.length === 0
        ? 'No account is bound yet. Bind one with gh_account action=bind, or write a token directly into $DSH_HOME/.credentials.yaml.'
        : `Current default account: ${describeAccount(activeRecord)}`,
    })
  }

  // ---------------------------------------------------------------- gh_api
  const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'])
  const apiTool = async (args, exec) => {
    const method = String(args.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw fail(`Unsupported method "${args.method}". Available: ${[...ALLOWED_METHODS].join(', ')}.`)
    }
    if (typeof args.endpoint !== 'string' || args.endpoint.trim() === '') {
      throw fail('endpoint is required: a GitHub API path starting with /, for example /repos/owner/repo/pulls.')
    }

    const isWrite = method !== 'GET' && method !== 'HEAD'
    // Authorization targets "which repository the request will actually hit": decide from
    // the normalized path, not the raw string (otherwise `..` can fool authorization while
    // the request lands on a different repository).
    const parsed = parseEndpoint(args.endpoint)
    const targetFromEndpoint = parsed.repo
    const declared = typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : undefined
    const declaredSlug = declared === undefined ? undefined : repoSlug(declared)
    if (targetFromEndpoint !== undefined && declaredSlug !== undefined
      && declaredSlug.toLowerCase() !== targetFromEndpoint.toLowerCase()) {
      throw fail(
        `The repo parameter (${declaredSlug}) and the repository the endpoint points at (${targetFromEndpoint}) do not match; refusing to run.`
        + ' Make both point at the same repository, or keep only one of them.',
      )
    }
    const effective = targetFromEndpoint ?? declaredSlug
    const allowlistActive = cfg.allowRepos.length > 0
    const repoScoped = REPO_SCOPED_PREFIXES.some(prefix => parsed.pathname.startsWith(prefix))

    if (isWrite) {
      if (!cfg.allowApiWrite) {
        throw fail(`Write operation (${method}) refused: allowApiWrite is configured as false. Read-only queries do not need that switch.`)
      }
      if (effective === undefined) {
        throw fail(
          `A write operation (${method}) cannot determine the target repository; refusing to run.`
          + ' Write the endpoint as /repos/{owner}/{repo}/… or provide the repo parameter (owner/repo).',
        )
      }
      if (!repoAllowed(cfg, effective)) {
        throw fail(`Target repository ${effective} is not in the allowRepos allowlist; refusing ${method} ${args.endpoint}.`)
      }
    } else if (effective !== undefined) {
      // Reads are bound by the allowlist as well: once allowRepos is set, repositories outside it must not be readable.
      if (!cfg.allowApiReadOutsideAllowlist && !repoAllowed(cfg, effective)) {
        throw fail(`Target repository ${effective} is not in the allowRepos allowlist; refusing ${method} ${args.endpoint}.`)
      }
    } else if (allowlistActive && repoScoped && !cfg.allowApiReadOutsideAllowlist) {
      // The allowlist is in effect, but the endpoint uses a prefix that may touch repository
      // content while the repository cannot be determined (e.g. /search/code, /user/repos) —
      // failing to parse a slug is no reason to silently allow it.
      throw fail(
        `Cannot tell the target repository from ${method} ${args.endpoint} while the allowRepos allowlist is in effect; refusing to run.`
        + ' Use an endpoint of the form /repos/{owner}/{repo}/…, or set allowApiReadOutsideAllowlist: true in the configuration.',
      )
    }

    // query / body are passed as JSON strings, to avoid depending on nested-object support in the parameter DSL.
    const query = parseJsonArg(args.query, 'query', 'object')
    const body = parseJsonArg(args.body, 'body', 'object')

    const auth = await token(cfg.workspaceRoot)
    const response = await githubRequest(args.endpoint, {
      method,
      token: auth.token,
      body,
      query,
      signal: exec.signal,
    })
    if (!response.ok) throw fail(response.error ?? `request failed (HTTP ${response.status})`)
    const payload = response.json ?? response.text
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    return {
      ok: true,
      status: response.status,
      endpoint: args.endpoint,
      method,
      rate_remaining: response.rateLimit?.remaining,
      truncated: serialized.length > 20_000,
      data: cap(serialized, 20_000),
    }
  }

  // ---------------------------------------------------------------- specs
  return {
    repo: {
      name: 'gh_repo',
      description: [
        'Operate on GitHub repositories in the local workspace: clone / fetch / status / diff / log / branches / create (create a remote repository).',
        'This is the first step for using the other gh_* tools: run action="clone" to pull owner/repo into the workspace, after which gh_file / gh_commit / gh_push all resolve the same local directory by owner/repo.',
        'Read-only operations can use just this tool; to push to the remote use gh_push (requires the plugin config allowPush: true).',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository identifier in owner/repo form, for example deepseek-ai/deepseek-harness (a full URL is also accepted).' },
        action: {
          type: 'string',
          required: true,
          description: 'The action to perform: clone (clone, or fetch an existing clone), status (working tree state and current commit), diff (uncommitted changes), log (commit history), branches (branches), create (create a new repository on GitHub).',
        },
        depth: { type: 'integer', description: 'Shallow clone depth for clone/fetch, for example 1. Omit for a full clone.' },
        staged: { type: 'boolean', description: 'For action=diff, look only at staged changes.' },
        file: { type: 'string', description: 'For action=diff/log, restrict to one file (path relative to the repository root).' },
        limit: { type: 'integer', description: 'For action=log, how many commits to return; default 20, range 1–200.' },
        name: { type: 'string', description: 'For action=create, the new repository name.' },
        owner: { type: 'string', description: 'For action=create, create under this organization (omit to create under the currently signed-in user account).' },
        description: { type: 'string', description: 'For action=create, the repository description.' },
        private: { type: 'boolean', description: 'For action=create, whether to create a private repository (default false).' },
      },
      async execute(args, exec) {
        const handler = repoAction[args.action]
        if (!handler) {
          throw fail(`Unsupported action "${args.action}". Available: ${Object.keys(repoAction).join(', ')}.`)
        }
        return handler(args, exec)
      },
    },

    file: {
      name: 'gh_file',
      description: [
        'Read and write files in the local clone (paths are relative to the repository root). action=get returns a line-numbered window, action=list lists a directory,',
        'action=put writes the whole file, action=edit performs a one-shot exact replacement (oldText must appear exactly once in the file).',
        'Changes are not committed automatically: use gh_commit to commit them.',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo form; must be a repository already cloned into the workspace.' },
        action: { type: 'string', required: true, description: 'get (read a file), list (list a directory), put (write/create the whole file), edit (exact replacement).' },
        path: { type: 'string', description: 'Path relative to the repository root. Required for get/list/put/edit (for list, omitting it lists the repository root).' },
        startLine: { type: 'integer', description: 'For action=get, the first line (1-based); default 1.' },
        endLine: { type: 'integer', description: 'For action=get, the last line (inclusive). If omitted, up to 400 lines are returned starting at startLine.' },
        content: { type: 'string', description: 'For action=put, the complete file content.' },
        overwrite: { type: 'boolean', description: 'For action=put, must be set to true explicitly to overwrite an existing file.' },
        oldText: { type: 'string', description: 'For action=edit, the exact original text to replace; must match the file exactly (including indentation).' },
        newText: { type: 'string', description: 'For action=edit, the replacement text; an empty string means delete.' },
        count: { type: 'integer', description: 'For action=edit, how many times oldText is expected to appear; default 1. The edit is refused if it does not match.' },
      },
      async execute(args, exec) {
        if (args.action !== 'list' && (typeof args.path !== 'string' || args.path === '')) {
          throw fail(`action=${args.action} requires the path parameter (a path relative to the repository root).`)
        }
        const handler = fileAction[args.action]
        if (!handler) {
          throw fail(`Unsupported action "${args.action}". Available: ${Object.keys(fileAction).join(', ')}.`)
        }
        return handler(args, exec)
      },
    },

    commit: {
      name: 'gh_commit',
      description: [
        'Stage changes in the local clone and commit them (by default the commit stays local). If paths is omitted, all changes are committed.',
        'Set push to true to commit and push in the same step (requires the plugin config allowPush: true).',
        'Write the commit message so it explains "why the change was made"; do not just write "update".',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo form.' },
        message: { type: 'string', required: true, description: 'Commit message (a one-line subject + blank line + explanation is recommended).' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of paths to commit (paths relative to the repository root). Omitted or an empty array means all changes.',
        },
        push: { type: 'boolean', description: 'Whether to push immediately after committing (requires allowPush: true). Default false.' },
        authorName: { type: 'string', description: 'Override the author name for this commit (otherwise the plugin config or the git global config is used).' },
        authorEmail: { type: 'string', description: 'Override the author email for this commit.' },
      },
      execute: commitTool,
    },

    push: {
      name: 'gh_push',
      description: [
        'Push local commits to origin. Requires the plugin config allowPush: true, and a token with write access to the repository.',
        'Before pushing, it is recommended to confirm what will be pushed with gh_repo action=status; if the remote has new commits, run gh_pull first.',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo form.' },
        branch: { type: 'string', description: 'Name of the remote branch to push to. Omit to push the current branch to the same-named remote branch.' },
        force: { type: 'boolean', description: 'Whether to force push (only --force-with-lease, and requires allowForcePush: true). Default false.' },
      },
      execute: pushTool,
    },

    pull: {
      name: 'gh_pull',
      description: 'Pull remote changes into the local clone. Defaults to --ff-only (a diverged branch fails clearly instead of manufacturing a merge conflict); with rebase: true it uses --rebase instead.',
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo form.' },
        rebase: { type: 'boolean', description: 'Use --rebase instead of --ff-only. Default false.' },
      },
      execute: pullTool,
    },

    account: {
      name: 'gh_account',
      description: [
        'GitHub account binding management. action=list lists bound accounts and the current default account; action=bind binds a new account (',
        'when no token is passed an input box appears for pasting a PAT, and the account becomes the default once bound); action=use switches the default account;',
        'action=remove deletes an account; action=status shows which credential source is currently in effect and which account it maps to (the token itself is not shown).',
        'The first time credentials are needed, the binding guide appears automatically; after that all gh_* calls use the bound account by default.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, description: 'bind (bind), list (list), use (switch), remove (delete), status (state).' },
        token: { type: 'string', description: 'PAT for action=bind; if omitted, an input box appears for the user to paste it.' },
        login: { type: 'string', description: 'Login name or account id for action=use / action=remove.' },
      },
      execute: accountTool,
    },

    config: {
      name: 'gh_config',
      description: [
        'GitHub access configuration: action=status shows whether a token is configured, which layer it comes from, and which GitHub account it maps to (the token itself is not shown);',
        'action=set stores a PAT in the DSH credentials service; action=unset deletes it.',
        'When a gh_* call reports 401 or says no credentials are configured, have the user provide a PAT first and then call action=set.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, description: 'status (default), set (store a token), unset (delete the token).' },
        token: { type: 'string', description: 'The plaintext GitHub Personal Access Token for action=set.' },
      },
      execute: async args => configTool(args),
    },

    api: {
      name: 'gh_api',
      description: [
        'Call the GitHub REST API directly (only api.github.com is allowed), for scenarios the other gh_* tools do not cover: issues, PRs, Actions, search, and so on.',
        'GET/HEAD are read-only; POST/PATCH/PUT/DELETE require the plugin config allowApiWrite: true.',
        'The repository allowlist (allowRepos) is judged from /repos/{owner}/{repo} in the endpoint; when the endpoint has no such path segment, supply the repo parameter instead.',
        'Results are returned as JSON and truncated automatically.',
      ].join(' '),
      parameters: {
        endpoint: { type: 'string', required: true, description: 'API path starting with /, for example /repos/owner/repo/pulls (put query parameters in query).' },
        method: { type: 'string', description: 'GET (default), POST, PATCH, PUT, DELETE, HEAD.' },
        repo: { type: 'string', description: 'owner/repo, used for allowlist validation; it is refused if it disagrees with the repository in the endpoint.' },
        query: { type: 'string', description: 'Query parameters as a JSON string, for example {"state":"open","per_page":20}.' },
        body: { type: 'string', description: 'Request body as a JSON string, for example {"title":"...","head":"feature","base":"main"}.' },
      },
      execute: apiTool,
    },
  }
}
