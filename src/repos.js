/**
 * dsh-plugin-github — repository resolution and access control
 *
 * Security model:
 *   - reads and writes happen only inside workspaceRoot (every path gets a real-path prefix check)
 *   - a non-empty allowRepos forms an allowlist, supporting the owner/repo, owner/* and * forms
 *   - pushing to a remote additionally requires allowPush: true, otherwise gh_push refuses outright
 */

import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { assertAllowedHost, isGitRepo, isLocalRepoRef, repoDirName, repoSlug, remoteUrl } from './git.js'

/**
 * @typedef {object} PluginConfig
 * @property {string} [workspaceRoot]
 * @property {string[]} [allowRepos]
 * @property {boolean} [allowPush]
 * @property {boolean} [allowApiWrite]
 * @property {string} [tokenRef]
 * @property {string} [tokenEnv]
 * @property {boolean} [dotenv]
 * @property {number} [commandTimeoutMs]
 * @property {number} [maxDiffChars]
 * @property {number} [maxReadChars]
 * @property {string} [gitAuthorName]
 * @property {string} [gitAuthorEmail]
 * @property {boolean} [allowForcePush]
 */

/** Normalize the config into its internal shape. */
export function normalizeConfig(raw, fallbackCwd) {
  const cfg = raw ?? {}
  const splitList = value => {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean)
    if (typeof value === 'string') return value.split(/[,\s]+/).map(v => v.trim()).filter(Boolean)
    return []
  }
  return {
    workspaceRoot: path.resolve(String(cfg.workspaceRoot ?? fallbackCwd)),
    allowRepos: splitList(cfg.allowRepos),
    allowPush: cfg.allowPush === true,
    allowForcePush: cfg.allowForcePush === true,
    allowApiWrite: cfg.allowApiWrite === true,
    /** Allow remotes that are not github.com (self-hosted Git services). Default false: any host = credentials can be sent to any host. */
    allowNonGithubRemotes: cfg.allowNonGithubRemotes === true,
    /** Whether read-only gh_api is also bound by allowRepos. Default true (once the allowlist is set it applies everywhere). */
    allowApiReadOutsideAllowlist: cfg.allowApiReadOutsideAllowlist === true,
    tokenRef: String(cfg.tokenRef ?? 'GITHUB_TOKEN'),
    tokenEnv: String(cfg.tokenEnv ?? 'GITHUB_TOKEN'),
    dotenv: cfg.dotenv !== false,
    commandTimeoutMs: Number.isFinite(cfg.commandTimeoutMs) ? Number(cfg.commandTimeoutMs) : 120_000,
    maxDiffChars: Number.isFinite(cfg.maxDiffChars) ? Number(cfg.maxDiffChars) : 20_000,
    maxReadChars: Number.isFinite(cfg.maxReadChars) ? Number(cfg.maxReadChars) : 40_000,
    /** Whether to pop up the bind prompt automatically the first time credentials are needed. Default true. */
    allowAutoBind: cfg.allowAutoBind !== false,
    /** Whether the prompt may ask the user to paste a token. Default true. */
    promptForToken: cfg.promptForToken !== false,
    /** Account store file path (only effective when the DSH credential service is not used). When omitted it is placed under $DSH_HOME. */
    accountStorePath: typeof cfg.accountStorePath === 'string' && cfg.accountStorePath !== '' ? cfg.accountStorePath : undefined,
    /** git executable to run; a host whose git is not on PATH can point at it directly. */
    gitExecutable: typeof cfg.gitExecutable === 'string' && cfg.gitExecutable.trim() !== '' ? cfg.gitExecutable.trim() : 'git',
    gitAuthorName: typeof cfg.gitAuthorName === 'string' ? cfg.gitAuthorName : undefined,
    gitAuthorEmail: typeof cfg.gitAuthorEmail === 'string' ? cfg.gitAuthorEmail : undefined,
  }
}

/** Whether a single repository is in the allowlist. */
export function repoAllowed(cfg, repo) {
  if (cfg.allowRepos.length === 0) return true
  const slug = repoSlug(repo)
  const name = String(repo ?? '').trim()
  for (const rule of cfg.allowRepos) {
    if (rule === '*') return true
    if (rule === name || rule === slug) return true
    if (rule.endsWith('/*')) {
      const owner = rule.slice(0, -2)
      if (slug?.toLowerCase().startsWith(`${owner.toLowerCase()}/`)) return true
    }
    if (rule.startsWith('*/') && slug?.toLowerCase().endsWith(rule.slice(1).toLowerCase())) return true
  }
  return false
}

/** Only strict owner/repo is allowed (an optional .git suffix is accepted). */
const STRICT_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * An allowRepos rule must be a strict owner/repo or a wildcard form.
 * A full URL is not accepted: the URL's host and extra path segments would both be ignored,
 * which amounts to allowing any host (found in review, D4: `allowRepos: ['b/c']` used to
 * authorize a push to any host on a path ending in b/c.git).
 */
function assertStrictAllowRule(rule) {
  const body = rule === '*' ? '*' : rule.endsWith('/*') ? `${rule.slice(0, -2)}/x` : rule.startsWith('*/') ? `x${rule.slice(1)}` : rule
  if (body === '*') return
  if (!STRICT_SLUG.test(body.replace(/\.git$/i, ''))) {
    throw new Error(
      `allowRepos rule "${rule}" is not a valid owner/repo form.`
      + ' Only owner/repo, owner/*, */repo and * are accepted; a full URL is not'
      + ' (a URL\'s host and extra path segments cannot be validated reliably).',
    )
  }
}

/** Validate allowRepos once at load time, so invalid rules never make it into runtime. */
export function assertAllowRules(cfg) {
  for (const rule of cfg.allowRepos) assertStrictAllowRule(rule)
  return cfg
}

/** Returns undefined when writing (remote operations other than fetch/pull) is allowed; otherwise returns the reason for the refusal. */
export function checkWriteAllowed(cfg, repo, action) {
  if (!repoAllowed(cfg, repo)) {
    return `Repository ${repo} is not in the allowRepos allowlist (current allowlist: ${cfg.allowRepos.join(', ') || 'empty = all repositories allowed, but writing still needs allowPush'}). Refusing ${action}.`
  }
  if (!cfg.allowPush) {
    return `The plugin config allowPush is false, so ${action} was refused. To allow writing to a remote, set allowPush: true for this plugin in cordis.patch.yml.`
  }
  return undefined
}

/** A local path must be inside workspaceRoot (judged by its real path, to prevent symlink escapes). */
export async function ensureInsideWorkspace(cfg, targetPath) {
  const resolved = path.resolve(targetPath)
  const relative = path.relative(cfg.workspaceRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${resolved} is not inside the workspace root ${cfg.workspaceRoot}.`)
  }
  if (relative === '') return resolved
  // Run one realpath check on the deepest ancestor that already exists; intermediate
  // directories that have not been created yet do not block.
  const realRoot = await realpath(cfg.workspaceRoot).catch(() => cfg.workspaceRoot)
  let probe = resolved
  for (;;) {
    let real
    try {
      real = await realpath(probe)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return resolved
      probe = parent
      continue
    }
    const realRelative = path.relative(realRoot, real)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`Path escapes the workspace (symlink): ${real} points outside the workspace.`)
    }
    return resolved
  }
}

/**
 * Resolve a repository → local path.
 * @param {PluginConfig} cfg
 * @param {string} repo owner/repo form
 * @param {{requireLocal?: boolean, dir?: string}} [options]
 * @returns {Promise<{dir: string, slug?: string, remote: string}>}
 */
export async function resolveRepo(cfg, repo, options = {}) {
  // Local paths (including file:// and absolute paths) are accepted too: for tests, mirrors,
  // or an existing local clone.
  const raw = String(repo ?? '').trim()
  const isLocalPath = isLocalRepoRef(raw)
  const slug = isLocalPath
    ? raw.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/')
    : repoSlug(raw)
  if (!slug) {
    throw new Error(
      `Cannot parse the repository identifier "${repo}". Use the owner/repo form, for example deepseek-ai/deepseek-harness.`,
    )
  }
  // The host must be allowed: the allowlist constrains only owner/repo, never the host. If an
  // arbitrary `http://attacker/allowed/repo.git` passed the allowlist, the plugin's PAT would
  // be sent to the attacker's host (found in review, D2). Note that the host must be judged
  // from the **raw input** — deriving a slug from it and pasting github.com back on would
  // launder the attacker's host away.
  const hostSource = isLocalPath || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^git@/i.test(raw)
    ? raw
    : remoteUrl(slug)
  const hostProblem = assertAllowedHost(hostSource, cfg.allowNonGithubRemotes === true)
  if (hostProblem !== undefined) {
    throw new Error(`Refusing repository "${raw}": ${hostProblem}.`)
  }
  const dir = options.dir
    ? await ensureInsideWorkspace(cfg, path.resolve(cfg.workspaceRoot, options.dir))
    : await ensureInsideWorkspace(cfg, path.join(cfg.workspaceRoot, repoDirName(raw)))

  if (options.requireLocal !== false && !(await isGitRepo(dir))) {
    const error = new Error(
      `There is no local clone of ${slug} yet: ${dir}\nCall gh_repo (action=clone, repo="${slug}") first, then continue.`,
    )
    error.code = 'REPO_NOT_CLONED'
    throw error
  }  return { dir, slug, remote: remoteUrl(slug) }
}

/** Build the compact summary text shown to the model. */
export function summarizeConfig(cfg, token) {
  return [
    `workspaceRoot: ${cfg.workspaceRoot}`,
    `allowRepos: ${cfg.allowRepos.length === 0 ? '(empty = repository names are not restricted)' : cfg.allowRepos.join(', ')}`,
    `allowPush: ${cfg.allowPush}`,
    `allowForcePush: ${cfg.allowForcePush}`,
    `allowApiWrite: ${cfg.allowApiWrite}`,
    `tokenRef: ${cfg.tokenRef}`,
    `token: ${token.configured ? `configured (source ${token.source})` : 'not configured'}`,
  ].join('\n')
}
