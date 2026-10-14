/**
 * dsh-plugin-github — 仓库定位与访问控制
 *
 * 安全模型：
 *   - workspaceRoot 之内才会被读写（每个路径都做真实路径前缀校验）
 *   - allowRepos 非空时构成白名单，支持 owner/repo、owner/*、* 三种写法
 *   - 推送到远端还需要 allowPush: true，否则 gh_push 直接拒绝
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

/** 把配置规范化成内部形态。 */
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
    /** 允许非 github.com 的远端（自建 Git 服务）。默认 false：任意主机 = 凭据可被送到任意主机。 */
    allowNonGithubRemotes: cfg.allowNonGithubRemotes === true,
    /** 只读的 gh_api 是否也受 allowRepos 约束。默认 true（白名单一旦设置就全面生效）。 */
    allowApiReadOutsideAllowlist: cfg.allowApiReadOutsideAllowlist === true,
    tokenRef: String(cfg.tokenRef ?? 'GITHUB_TOKEN'),
    tokenEnv: String(cfg.tokenEnv ?? 'GITHUB_TOKEN'),
    dotenv: cfg.dotenv !== false,
    commandTimeoutMs: Number.isFinite(cfg.commandTimeoutMs) ? Number(cfg.commandTimeoutMs) : 120_000,
    maxDiffChars: Number.isFinite(cfg.maxDiffChars) ? Number(cfg.maxDiffChars) : 20_000,
    maxReadChars: Number.isFinite(cfg.maxReadChars) ? Number(cfg.maxReadChars) : 40_000,
    /** 首次需要凭据时是否自动弹出绑定引导。默认 true。 */
    allowAutoBind: cfg.allowAutoBind !== false,
    /** 是否允许在引导里让用户粘贴 token。默认 true。 */
    promptForToken: cfg.promptForToken !== false,
    /** 账号存储文件路径（仅在不使用 DSH 凭据服务时生效）。省略则放在  下。 */
    accountStorePath: typeof cfg.accountStorePath === 'string' && cfg.accountStorePath !== '' ? cfg.accountStorePath : undefined,
    gitAuthorName: typeof cfg.gitAuthorName === 'string' ? cfg.gitAuthorName : undefined,
    gitAuthorEmail: typeof cfg.gitAuthorEmail === 'string' ? cfg.gitAuthorEmail : undefined,
  }
}

/** 单个仓库是否在白名单内。 */
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

/** 只允许严格的 owner/repo（可带 .git 后缀）。 */
const STRICT_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * 白名单规则必须是严格 owner/repo 或通配形式。
 * 不接受完整 URL：URL 的 host 与额外路径段都会被忽略，等于放行任意主机
 * （审查发现 D4：`allowRepos: ['b/c']` 曾能授权推送到任意 host 上以 b/c.git 结尾的路径）。
 */
function assertStrictAllowRule(rule) {
  const body = rule === '*' ? '*' : rule.endsWith('/*') ? `${rule.slice(0, -2)}/x` : rule.startsWith('*/') ? `x${rule.slice(1)}` : rule
  if (body === '*') return
  if (!STRICT_SLUG.test(body.replace(/\.git$/i, ''))) {
    throw new Error(
      `allowRepos 规则 "${rule}" 不是合法的 owner/repo 形式。`
      + '只接受 owner/repo、owner/*、*/repo、*；不接受完整 URL'
      + '（URL 的主机与额外路径段无法被可靠校验）。',
    )
  }
}

/** 加载时校验一次 allowRepos，避免把非法规则带进运行时。 */
export function assertAllowRules(cfg) {
  for (const rule of cfg.allowRepos) assertStrictAllowRule(rule)
  return cfg
}

/** 允许写入（fetch/pull 之外的远端操作）时返回 undefined；否则返回拒绝原因。 */
export function checkWriteAllowed(cfg, repo, action) {
  if (!repoAllowed(cfg, repo)) {
    return `仓库 ${repo} 不在 allowRepos 白名单内（当前白名单：${cfg.allowRepos.join(', ') || '空=全部允许但写入仍需 allowPush'}）。拒绝 ${action}。`
  }
  if (!cfg.allowPush) {
    return `插件配置 allowPush 为 false，已拒绝 ${action}。如需允许写远端，请在 cordis.patch.yml 里为该插件设置 allowPush: true。`
  }
  return undefined
}

/** 本地路径必须在 workspaceRoot 之内（用真实路径判定，防符号链接逃逸）。 */
export async function ensureInsideWorkspace(cfg, targetPath) {
  const resolved = path.resolve(targetPath)
  const relative = path.relative(cfg.workspaceRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径越界：${resolved} 不在工作区根目录 ${cfg.workspaceRoot} 之内。`)
  }
  if (relative === '') return resolved
  // 已存在的最深祖先进一次 realpath 校验，未创建的中间目录不阻断。
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
      throw new Error(`路径越界（符号链接）：${real} 指向工作区之外。`)
    }
    return resolved
  }
}

/**
 * 解析仓库 → 本地路径。
 * @param {PluginConfig} cfg
 * @param {string} repo owner/repo 形式
 * @param {{requireLocal?: boolean, dir?: string}} [options]
 * @returns {Promise<{dir: string, slug?: string, remote: string}>}
 */
export async function resolveRepo(cfg, repo, options = {}) {
  // 本地路径（含 file:// 与绝对路径）也接受：用于测试、镜像或已有本地克隆。
  const raw = String(repo ?? '').trim()
  const isLocalPath = isLocalRepoRef(raw)
  const slug = isLocalPath
    ? raw.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/')
    : repoSlug(raw)
  if (!slug) {
    throw new Error(
      `无法解析仓库标识 "${repo}"。请使用 owner/repo 形式，例如 deepseek-ai/deepseek-harness。`,
    )
  }
  // 主机必须被允许：白名单只约束 owner/repo，不约束主机。如果任意的
  // `http://attacker/allowed/repo.git` 能通过白名单，插件的 PAT 就会被送到攻击者主机
  // （审查发现 D2）。注意必须拿**原始输入**判主机——用它派生出来的 slug 再拼回
  // github.com 会把攻击者主机洗掉。
  const hostSource = isLocalPath || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^git@/i.test(raw)
    ? raw
    : remoteUrl(slug)
  const hostProblem = assertAllowedHost(hostSource, cfg.allowNonGithubRemotes === true)
  if (hostProblem !== undefined) {
    throw new Error(`拒绝仓库 "${raw}"：${hostProblem}。`)
  }
  const dir = options.dir
    ? await ensureInsideWorkspace(cfg, path.resolve(cfg.workspaceRoot, options.dir))
    : await ensureInsideWorkspace(cfg, path.join(cfg.workspaceRoot, repoDirName(raw)))

  if (options.requireLocal !== false && !(await isGitRepo(dir))) {
    const error = new Error(
      `本地还没有 ${slug} 的克隆：${dir}\n先调用 gh_repo（action=clone, repo="${slug}"）再继续。`,
    )
    error.code = 'REPO_NOT_CLONED'
    throw error
  }  return { dir, slug, remote: remoteUrl(slug) }
}

/** 生成给模型看的紧凑概览文本。 */
export function summarizeConfig(cfg, token) {
  return [
    `workspaceRoot: ${cfg.workspaceRoot}`,
    `allowRepos: ${cfg.allowRepos.length === 0 ? '（空 = 不限制仓库名）' : cfg.allowRepos.join(', ')}`,
    `allowPush: ${cfg.allowPush}`,
    `allowForcePush: ${cfg.allowForcePush}`,
    `allowApiWrite: ${cfg.allowApiWrite}`,
    `tokenRef: ${cfg.tokenRef}`,
    `token: ${token.configured ? `已配置（来源 ${token.source}）` : '未配置'}`,
  ].join('\n')
}
