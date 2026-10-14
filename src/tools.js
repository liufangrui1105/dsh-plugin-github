/**
 * dsh-plugin-github — 工具定义层
 *
 * 只描述工具的形状与实现，不关心注册方式：
 * 每个 ToolSpec 提供 name / description / parameters / execute。
 * index.js 负责把这些声明转成 dsh-tools 需要的 ToolDefinition 并注册。
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
 * 校验推送时会用到的**每一个**远端地址。
 *
 * `assertOriginMatches` 只看 fetch URL，而 `git push` 优先使用 `remote.origin.pushurl`。
 * 只校验前者会让「被授权的地址」与「真正被访问的地址」不一致：一个写进 .git/config 的
 * pushurl 就能把带 PAT 的请求送到别的主机（审查发现 D3）。
 * @param {import('./repos.js').PluginConfig} cfg
 * @param {{dir: string, slug: string, token?: string, signal?: AbortSignal}} options
 */
async function assertPushTargetsTrusted(cfg, options) {
  const { dir, slug, token, signal } = options
  const targets = await pushUrls(dir, { token, signal })
  const allowNonGithub = cfg.allowNonGithubRemotes === true
  if (targets.length === 0) {
    // 没有显式 pushurl 时 git 用 fetch URL，必须照常校验。
    assertOriginMatches({ dir, requested: slug, actual: await originUrl(dir, { token, signal }), kind: 'origin', allowNonGithub })
    return
  }
  for (const target of targets) {
    assertOriginMatches({ dir, requested: slug, actual: target, kind: `推送地址 ${target}`, allowNonGithub })
  }
}

const text = value => [{ type: 'text', text: value }]

/** 截断长文本（同时给出原文长度，避免模型误判结果完整性）。 */
function cap(value, max) {
  const textValue = String(value ?? '')
  if (textValue.length <= max) return textValue
  return `${textValue.slice(0, max)}\n…（已截断：共 ${textValue.length} 字符，上限 ${max}）`
}

/**
 * 递归删除对象里的 `undefined` 属性。
 *
 * 宿主的 output 校验用的是「无损 JSON」判定：`JSON.stringify` 会丢掉 `undefined` 属性，
 * 于是 `{ ok: true, x: undefined }` 序列化后与校验前的值不一致，整次工具调用会被判为
 * `value is not lossless JSON` 并失败（在真实宿主里实测踩到）。因此任何可选字段都必须
 * 在这里被摘掉，而不是留在对象里。
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
 * 解析 token 并规范成可安全放进工具返回值的形态。
 *
 * `ResolvedCredential.value` 是 secret，绝不能进入任何工具返回值——在源头就只保留
 * 来源与配置状态，避免哪天不小心把整个对象返回出去。
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

/** 统一包装：任何抛出都变成清晰的工具错误。 */
function fail(message) {
  const error = new Error(message)
  error.toolFailure = true
  return error
}

/**
 * 解析以 JSON 字符串传入的复杂参数。
 * 用字符串而不是嵌套对象，是为了不依赖参数 DSL 的嵌套对象写法，两边注册路径都安全。
 * @param {unknown} raw
 * @param {string} name
 * @param {'object'|'array'} kind
 */
function parseJsonArg(raw, name, kind) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') throw fail(`${name} 需要 JSON 字符串。`)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw fail(`${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (kind === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw fail(`${name} 必须是 JSON 对象，例如 {"state":"open"}。`)
  }
  return parsed
}

/**
 * 规范化 API endpoint 并解析出目标仓库（owner/repo）。
 *
 * 必须先用 `new URL()` 规范化再解析路径：授权看的是原始字符串，而真正发出去的请求走
 * URL 规范化，`/repos/allowed/repo/../../secret/repo/issues` 会被授权成 `allowed/repo`
 * 却打到 `secret/repo`（审查发现 D1）。规范化后按 `/repos/{owner}/{repo}` 取。
 *
 * @param {string} endpoint
 * @returns {{ pathname: string, host: string, repo?: string }}
 * @throws {Error} endpoint 无法解析，或指向非 api.github.com 的主机
 */
function parseEndpoint(endpoint) {
  const raw = String(endpoint).trim()
  const absolute = /^https?:\/\//i.test(raw)
  let url
  try {
    url = new URL(raw, 'https://api.github.com')
  } catch {
    throw fail(`endpoint 无法解析："${raw}"。示例：/repos/owner/repo/pulls。`)
  }
  if (absolute && url.hostname.toLowerCase() !== 'api.github.com') {
    throw fail(`出于安全考虑，只允许访问 api.github.com（收到 ${url.origin}）。`)
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
 * 哪些 endpoint 前缀可能触及仓库内容或状态（有白名单时不应被默许绕过）。
 * `/user`、`/rate_limit` 这类账号/元信息端点不属于仓库内容，放行。
 */
const REPO_SCOPED_PREFIXES = [
  '/repos/', '/search/', '/orgs/', '/users/', '/user/repos', '/user/subscriptions',
  '/user/starred', '/gists/', '/installation/', '/app/',
]


/**
 * 拒绝写入 .git 内部文件。
 *
 * `.git/config` 能改 `remote.origin.pushurl`（把带 PAT 的推送重定向到别的主机），
 * `.git/hooks/*` 是任意代码执行，`.git/HEAD` 等会直接破坏仓库。读取仍然允许
 * （某些排查场景需要看 config），写入一律拒绝。
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
      `拒绝修改 ${relative}：.git 目录内部（config / hooks / HEAD 等）不允许通过 gh_file 写入。`
      + '.git/config 可以重定向推送地址（把凭据发到别的主机），.git/hooks 则是任意代码执行。',
    )
  }
}

/**
 * @typedef {object} ToolContext
 * @property {import('./repos.js').PluginConfig} config
 * @property {{credentials?: unknown, agents?: {currentInitiator?: () => unknown}} } host
 */

/**
 * 构造全部工具定义。
 * @param {ToolContext} context
 */
export function buildToolSpecs(context) {
  const cfg = context.config
  const accounts = context.host.accounts
  const userQuestions = context.host.userQuestions

  /** 解析 token（每次调用都重新解析，保证切换账号/轮换凭据立即生效）。 */
  const token = async cwd => resolveToken({
    accounts,
    credentials: context.host.credentials,
    tokenRef: cfg.tokenRef,
    tokenEnv: cfg.tokenEnv,
    dotenv: cfg.dotenv,
    cwd: cwd ?? cfg.workspaceRoot,
  })

  /**
   * 需要凭据的操作统一走这里：
   *   1. 先按正常顺序解析；
   *   2. 解析不到且是一次「真人可交互」的调用 → 弹出绑定引导，绑定后立即重试；
   *   3. 仍然拿不到 → 抛出带可操作指引的错误。
   *
   * @param {string} reason 为什么要凭据（用于引导文案）
   * @param {{cwd?: string, exec?: any}} [options]
   */
  const requireToken = async (reason, options = {}) => {
    const first = await token(options.cwd)
    // 已经明确生效的凭据（绑定账号 / 凭据服务 / 非回退路径）直接用。
    if (first.configured && first.viaEnvFallback !== true) return first

    // 能否向用户提问，是「要不要弹绑定引导」的唯一门槛。
    // 交互不可用（子代理、无 UI 运行时、配置关掉）时**不阻断**：照旧把操作放下去，
    // 让远端自己决定成败——这样本地/内网不需要凭据的远端仍然能用。
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
      const bound = await accounts.bind(asked.token, { source: 'gh_account bind（对话输入）' })
      const retried = await token(options.cwd)
      if (retried.configured) {
        return { ...retried, detail: `${retried.detail}（刚刚绑定 @${bound.login}）`, justBound: bound.login }
      }
    }

    if (asked.status === 'skipped') {
      // 用户主动跳过：尊重选择，让操作照旧往下走。
      return first
    }

    // 交互不可用，但有环境变量兜底 → 用它。
    if (first.configured) return first
    throw fail(unboundMessage(asked.detail))
  }

  // ---------------------------------------------------------------- gh_repo
  const repoAction = {
    clone: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo, { requireLocal: false })
      // 白名单必须针对「将要操作的那个仓库」，而不是别的派生字符串。
      if (!repoAllowed(cfg, slug)) {
        throw fail(`仓库 ${slug} 不在 allowRepos 白名单内（当前：${cfg.allowRepos.join(', ')}）。`)
      }
      // 目录已存在时，origin 必须就是请求的仓库：否则 fetch 会去拉另一个远端。
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
          `${reused ? 'fetch' : 'clone'} 失败：${result.error ?? (result.stderr || '未知错误')}\n`
          + `目标目录：${dir}\n`
          + (auth.configured ? '' : `提示：未配置 token（${auth.detail}）。私有仓库需要 token；公开仓库也应该配置以避免限流。`),
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
        note: reused ? '本地已存在该仓库，只做了 fetch --prune' : '克隆完成',
        output: cap(result.stderr || result.stdout, 4000),
      })
    },

    status: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const { entries, result } = await statusEntries(dir, { signal: exec.signal })
      if (!result.ok) {
        throw fail(`git status 失败（${dir} 可能不是有效的 git 仓库）：${result.error ?? (result.stderr || result.stdout)}`)
      }
      const head = await headCommit(dir, { signal: exec.signal })
      const origin = await originUrl(dir, { signal: exec.signal })
      // head/origin 都可能是 undefined（空仓库、没有 remote）：必须摘掉而不是留在返回值里。
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
        diff: body === '' ? '（没有差异）' : body,
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
        throw fail(`git log 失败：${result.error ?? (result.stderr || result.stdout)}`)
      }
      return { ok: true, action: 'log', repo: slug, limit, count: entries.length, commits: entries }
    },

    branches: async (args, exec) => {
      const { dir, slug } = await resolveRepo(cfg, args.repo)
      const { entries, result } = await branches(dir, { signal: exec.signal })
      if (!result.ok) {
        throw fail(`git branch 失败：${result.error ?? (result.stderr || result.stdout)}`)
      }
      return { ok: true, action: 'branches', repo: slug, branches: entries }
    },

    create: async (args, exec) => {
      // 建远端仓库是写操作：必须显式开启 allowApiWrite，并按 owner/name 过白名单。
      if (!cfg.allowApiWrite) {
        throw fail('action=create 被拒绝：配置 allowApiWrite 为 false（创建远端仓库属于写操作）。')
      }
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw fail('action=create 需要 name 参数（新仓库名）。')
      }
      const newName = args.name.trim()
      if (!/^[A-Za-z0-9._-]+$/.test(newName)) {
        throw fail(`仓库名 "${args.name}" 非法：只允许字母、数字、点、下划线、连字符。`)
      }
      const ownerScoped = typeof args.owner === 'string' && args.owner.trim() !== ''
      const owner = ownerScoped ? args.owner.trim() : undefined
      if (owner !== undefined && !/^[A-Za-z0-9._-]+$/.test(owner)) {
        throw fail(`owner "${args.owner}" 非法：只允许字母、数字、点、下划线、连字符。`)
      }
      if (owner !== undefined && !repoAllowed(cfg, `${owner}/${newName}`)) {
        throw fail(`目标 ${owner}/${newName} 不在 allowRepos 白名单内，拒绝创建。`)
      }
      if (owner === undefined && cfg.allowRepos.length > 0) {
        // 不带 owner 会创建到「当前登录账号」下，无法与白名单比对——不能因为无法判断就放行。
        throw fail(
          'allowRepos 白名单已生效时，action=create 必须显式给出 owner（否则目标账号无法与白名单比对）。'
          + '请传 owner: "your-name"。',
        )
      }
      const auth = await requireToken('创建远端仓库需要写权限。', { cwd: cfg.workspaceRoot, exec })
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
        // 缺凭据时 GitHub 返回 401/403：把「去绑定账号」这一步明确说出来，
        // 而不是把裸 HTTP 错误丢给用户。
        if (response.status === 401 || response.status === 403) {
          throw fail(
            `创建仓库失败（HTTP ${response.status}）：${response.error ?? '认证失败'}\n`
            + unboundMessage(auth.detail),
          )
        }
        throw fail(response.error ?? '创建仓库失败')
      }
      const created = /** @type {{full_name?: string, html_url?: string, clone_url?: string}} */ (response.json ?? {})
      return {
        ok: true,
        action: 'create',
        repo: created.full_name,
        url: created.html_url,
        clone_url: created.clone_url,
        note: `已创建远端仓库。可用 gh_repo action=clone repo="${created.full_name}" 克隆到工作区。`,
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
        throw fail(`读取失败 ${relative}：${error instanceof Error ? error.message : String(error)}`)
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
        // 只有真的漏掉了内容才算截断：读到文件末尾时不该误报。
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
        throw fail(`列目录失败 ${args.path ?? '.'}：${error instanceof Error ? error.message : String(error)}`)
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
      if (typeof args.content !== 'string') throw fail('action=put 需要 content 参数。')
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
          `${relative} 已存在。要整体覆盖请设置 overwrite: true；只是局部改动用 gh_file action=edit。`,
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
        note: existed ? '已覆盖写入' : '已新建文件',
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
        throw fail(`读取失败 ${relative}：${error instanceof Error ? error.message : String(error)}`)
      }
      if (typeof args.oldText !== 'string' || args.oldText === '') {
        throw fail('action=edit 需要非空的 oldText。')
      }
      if (typeof args.newText !== 'string') throw fail('action=edit 需要 newText（可为空字符串表示删除）。')

      const parts = original.split(args.oldText)
      const occurrences = parts.length - 1
      const expected = Number.isFinite(args.count) ? Number(args.count) : 1
      if (expected < 1) throw fail(`count 必须 ≥ 1，收到 ${args.count}。`)
      if (occurrences === 0) {
        throw fail(`${relative} 中找不到 oldText。请先用 gh_file action=get 确认原文（注意缩进与换行）。`)
      }
      if (occurrences !== expected) {
        throw fail(
          `${relative} 中 oldText 出现 ${occurrences} 次，与 count=${expected} 不符。`
          + '请扩大上下文让 oldText 唯一，或用 count 明确要替换几次。',
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
      throw fail(`git add 失败：${addResult.error ?? (addResult.stderr || addResult.stdout)}\n（路径：${paths.join(', ')}）`)
    }

    const { entries } = await statusEntries(dir, { signal: exec.signal })
    const stagedEntries = entries.filter(entry => entry.code !== '??')
    if (stagedEntries.length === 0) {
      throw fail(
        '暂存区为空，没有可提交的内容。'
        + '（可能 path 写错了，或改动已被忽略；用 gh_repo action=status 查看。）',
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
      throw fail(`git commit 失败：${commitResult.error ?? (commitResult.stderr || commitResult.stdout)}`)
    }
    const after = await headCommit(dir, { signal: exec.signal })

    let pushed
    if (args.push === true) {
      const denied = checkWriteAllowed(cfg, slug, 'push')
      if (denied) throw fail(`${denied}\n（提交已在本地完成：${after?.sha}，但未推送。）`)
      const auth = await requireToken('推送提交到远端需要写权限。', { cwd: dir, exec })
      await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
      const pushResult = await gitPush(dir, { token: auth.token, signal: exec.signal, setUpstream: true })
      if (!pushResult.ok) {
        throw fail(
          `已在本地提交 ${after?.sha}，但推送失败：${pushResult.error ?? (pushResult.stderr || pushResult.stdout)}\n`
          + '（可用 gh_repo action=status 检查，再调用 gh_push 单独重试推送。）',
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
    // 先过白名单，再去碰本地路径：未授权仓库不该因为「目录不存在」而泄漏本地布局信息。
    const requestedSlug = repoSlug(String(args.repo)) ?? String(args.repo)
    const denied = checkWriteAllowed(cfg, requestedSlug, 'push')
    if (denied) throw fail(denied)
    const { dir, slug } = await resolveRepo(cfg, args.repo)
    const auth = await requireToken('推送到远端需要写权限。', { cwd: dir, exec })
    // 白名单校验的是 args.repo，实际推送目标是目录里的 origin——两者必须一致。
    await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
    if (args.force === true && !cfg.allowForcePush) {
      throw fail('force 推送被拒绝：配置 allowForcePush 为 false。（即便开启也只使用 --force-with-lease。）')
    }
    const before = await headCommit(dir, { signal: exec.signal })
    // 没有 token 时不直接拒绝：本地/内网远端可能本来就不需要凭据，
    // 让远端自己决定，失败时再给出「配置 token」的可操作提示。
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
        ? `\n当前没有可用凭据（${auth.detail}）。请用 gh_config action=set 写入 PAT，或设置环境变量 ${cfg.tokenEnv}。`
        : '常见原因：远端有新提交（先 gh_pull）；分支保护不允许直推（改用 PR 流程）；token 缺少 repo 权限。'
      throw fail(`推送失败：${result.error ?? (result.stderr || result.stdout)}\n${hint}`)
    }
    return {
      ok: true,
      action: 'push',
      repo: slug,
      head: before,
      branch: args.branch ?? '（当前分支 → 同名远端分支）',
      force: args.force === true,
      output: cap(result.stderr || result.stdout, 4000),
    }
  }

  // ---------------------------------------------------------------- gh_pull
  const pullTool = async (args, exec) => {
    const { dir, slug } = await resolveRepo(cfg, args.repo)
    const auth = await requireToken('拉取远端改动需要凭据。', { cwd: dir, exec })
    // 拉取会改动本地历史，同样要求 origin 与请求的仓库一致。
    await assertPushTargetsTrusted(cfg, { dir, slug, token: auth.token, signal: exec.signal })
    const before = await headCommit(dir, { signal: exec.signal })
    const result = await gitPull(dir, {
      token: auth.token,
      signal: exec.signal,
      rebase: args.rebase === true,
    })
    if (!result.ok) {
      const hint = /diverg|non-fast-forward|Not possible to fast-forward/i.test(`${result.stderr}${result.stdout}`)
        ? '\n本地与远端已分叉。可选择：把 rebase: true 打开重试，或先 gh_commit 提交本地改动再处理。'
        : ''
      throw fail(`拉取失败：${result.error ?? (result.stderr || result.stdout)}${hint}`)
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
        throw fail('action=set 需要 token 参数（GitHub Personal Access Token）。')
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
        : { ok: false, error: who.error ?? '请求失败' }
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
   * 账号绑定工具。这是用户「绑定哪个 GitHub 账号」的显式入口，
   * 也是首次使用时自动引导的落点。
   */
  const accountTool = async (args, exec) => {
    if (accounts === undefined) {
      throw fail(
        '账号存储不可用，无法管理账号绑定。'
        + `可改为在 $DSH_HOME/.credentials.yaml 的 refs: 段写入 ${cfg.tokenRef}，或设置环境变量 ${cfg.tokenEnv}。`,
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
          ? '还没有绑定任何账号。用 action=bind 绑定（会弹出输入框，或直接把 token 传进来）。'
          : '用 action=use 切换默认账号。',
      })
    }

    if (args.action === 'bind') {
      let token = typeof args.token === 'string' && args.token.trim() !== '' ? args.token.trim() : undefined
      let fromPrompt = false

      if (token === undefined) {
        // 没直接给 token：优先弹引导。
        const asked = await askForToken({
          userQuestions,
          agent: exec?.agent,
          signal: exec?.signal,
          reason: '绑定 GitHub 账号需要你的 Personal Access Token。',
        })
        if (asked.status === 'answered') {
          token = asked.token
          fromPrompt = true
        } else if (asked.status === 'unavailable') {
          // 环境变量里的 token 也算一种绑定方式（只是不写盘）。
          const fromHost = context.host.envToken?.value
          const fromProcess = process.env[cfg.tokenEnv] ?? process.env.GITHUB_TOKEN
          const envToken = typeof fromHost === 'string' && fromHost !== '' ? fromHost : fromProcess
          if (typeof envToken === 'string' && envToken.trim() !== '') {
            token = envToken.trim()
          } else {
            throw fail(
              `${asked.detail}\n`
              + '请改用：把 token 传给 gh_account action=bind 的 token 参数；'
              + '或自己在 $DSH_HOME/.credentials.yaml 的 refs: 段写入 '
              + `${cfg.tokenRef}；或设置环境变量 ${cfg.tokenEnv}。`,
            )
          }
        } else {
          throw fail('已取消绑定。需要时再调用 gh_account action=bind。')
        }
      }

      const bound = await accounts.bind(token, {
        source: fromPrompt ? 'gh_account bind（对话输入）' : 'gh_account bind（token 参数）',
      })
      return pruneUndefined({
        ok: true,
        action: 'bind',
        backend: accounts.backend,
        active: bound.id,
        account: accountView(bound, bound.id),
        note: `已绑定并设为默认账号 @${bound.login}。之后所有 gh_* 调用默认使用这个账号。`,
        security_note: fromPrompt
          ? 'token 是通过对话输入的，因此它出现在本次会话记录里。若不希望如此，可改从凭据文件或环境变量提供，并删除当前绑定再重新绑定。'
          : undefined,
      })
    }

    if (args.action === 'use') {
      if (typeof args.login !== 'string' || args.login.trim() === '') {
        throw fail('action=use 需要 login 参数（登录名或账号 id）。')
      }
      const record = await accounts.use(args.login)
      return pruneUndefined({
        ok: true,
        action: 'use',
        backend: accounts.backend,
        active: record.id,
        account: accountView(record, record.id),
        note: `已把默认账号切换为 @${record.login}。`,
      })
    }

    if (args.action === 'remove') {
      if (typeof args.login !== 'string' || args.login.trim() === '') {
        throw fail('action=remove 需要 login 参数（登录名或账号 id）。')
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
          ? '已删除该账号；它原本是默认账号，现在需要在下次需要凭据时重新指定或绑定。'
          : '已删除该账号。',
      })
    }

    // 默认 action=status
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
        : { ok: false, error: who.error ?? '请求失败' }
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
        ? '还没有绑定账号。用 gh_account action=bind 绑定，或直接在 $DSH_HOME/.credentials.yaml 写入 token。'
        : `当前默认账号：${describeAccount(activeRecord)}`,
    })
  }

  // ---------------------------------------------------------------- gh_api
  const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'])
  const apiTool = async (args, exec) => {
    const method = String(args.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw fail(`不支持的 method "${args.method}"。可用：${[...ALLOWED_METHODS].join(', ')}。`)
    }
    if (typeof args.endpoint !== 'string' || args.endpoint.trim() === '') {
      throw fail('endpoint 必填：以 / 开头的 GitHub API 路径，例如 /repos/owner/repo/pulls。')
    }

    const isWrite = method !== 'GET' && method !== 'HEAD'
    // 授权针对「请求实际会打到哪个仓库」：用规范化后的路径判定，而不是原始字符串
    // （否则 `..` 能骗过授权，请求却打到另一个仓库）。
    const parsed = parseEndpoint(args.endpoint)
    const targetFromEndpoint = parsed.repo
    const declared = typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : undefined
    const declaredSlug = declared === undefined ? undefined : repoSlug(declared)
    if (targetFromEndpoint !== undefined && declaredSlug !== undefined
      && declaredSlug.toLowerCase() !== targetFromEndpoint.toLowerCase()) {
      throw fail(
        `repo 参数（${declaredSlug}）与 endpoint 指向的仓库（${targetFromEndpoint}）不一致，拒绝执行。`
        + '请让两者指向同一个仓库，或只保留其中一个。',
      )
    }
    const effective = targetFromEndpoint ?? declaredSlug
    const allowlistActive = cfg.allowRepos.length > 0
    const repoScoped = REPO_SCOPED_PREFIXES.some(prefix => parsed.pathname.startsWith(prefix))

    if (isWrite) {
      if (!cfg.allowApiWrite) {
        throw fail(`写操作（${method}）被拒绝：配置 allowApiWrite 为 false。只读查询无需该开关。`)
      }
      if (effective === undefined) {
        throw fail(
          `写操作（${method}）无法确定目标仓库，拒绝执行。`
          + '请把 endpoint 写成 /repos/{owner}/{repo}/… 形式，或提供 repo 参数（owner/repo）。',
        )
      }
      if (!repoAllowed(cfg, effective)) {
        throw fail(`目标仓库 ${effective} 不在 allowRepos 白名单内，拒绝 ${method} ${args.endpoint}。`)
      }
    } else if (effective !== undefined) {
      // 只读同样受白名单约束：一旦设置了 allowRepos，就不该能读到白名单外的仓库。
      if (!cfg.allowApiReadOutsideAllowlist && !repoAllowed(cfg, effective)) {
        throw fail(`目标仓库 ${effective} 不在 allowRepos 白名单内，拒绝 ${method} ${args.endpoint}。`)
      }
    } else if (allowlistActive && repoScoped && !cfg.allowApiReadOutsideAllowlist) {
      // 白名单生效、但 endpoint 属于「可能触及仓库内容」的前缀却无法确定仓库
      // （例如 /search/code、/user/repos）——不能因为解析不出 slug 就默许放行。
      throw fail(
        `无法从 ${method} ${args.endpoint} 判断目标仓库，而 allowRepos 白名单已生效，拒绝执行。`
        + '请改用 /repos/{owner}/{repo}/… 形式的 endpoint，或在配置里设置 allowApiReadOutsideAllowlist: true。',
      )
    }

    // query / body 用 JSON 字符串传，避免依赖参数 DSL 的嵌套对象支持。
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
    if (!response.ok) throw fail(response.error ?? `请求失败（HTTP ${response.status}）`)
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
        '在本地工作区里操作 GitHub 仓库：clone / fetch / status / diff / log / branches / create（创建远端仓库）。',
        '这是使用其它 gh_* 工具的第一步：先用 action="clone" 把 owner/repo 拉到工作区，之后的 gh_file / gh_commit / gh_push 都按 owner/repo 定位同一个本地目录。',
        '只读动作用这个工具即可；推送到远端请用 gh_push（需要插件配置 allowPush: true）。',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: '仓库标识，owner/repo 形式，例如 deepseek-ai/deepseek-harness（也接受完整 URL）。' },
        action: {
          type: 'string',
          required: true,
          description: '要执行的动作：clone（克隆或 fetch 已存在克隆）、status（工作区状态与当前提交）、diff（未提交差异）、log（提交历史）、branches（分支）、create（在 GitHub 上新建仓库）。',
        },
        depth: { type: 'integer', description: 'clone/fetch 的浅克隆深度，例如 1。省略为完整克隆。' },
        staged: { type: 'boolean', description: 'action=diff 时只看已暂存的改动。' },
        file: { type: 'string', description: 'action=diff/log 时限定到某个文件（仓库内相对路径）。' },
        limit: { type: 'integer', description: 'action=log 返回的提交条数，默认 20，范围 1–200。' },
        name: { type: 'string', description: 'action=create 时的新仓库名。' },
        owner: { type: 'string', description: 'action=create 时创建到某个组织下（省略则创建到当前登录用户账号下）。' },
        description: { type: 'string', description: 'action=create 时的仓库描述。' },
        private: { type: 'boolean', description: 'action=create 时是否创建为私有仓库（默认 false）。' },
      },
      async execute(args, exec) {
        const handler = repoAction[args.action]
        if (!handler) {
          throw fail(`不支持的 action "${args.action}"。可用：${Object.keys(repoAction).join(', ')}。`)
        }
        return handler(args, exec)
      },
    },

    file: {
      name: 'gh_file',
      description: [
        '读写本地克隆里的文件（路径相对仓库根目录）。action=get 返回带行号的窗口，action=list 列目录，',
        'action=put 整份写入，action=edit 做一次性精确替换（oldText 必须在文件里唯一出现）。',
        '修改后不会自动提交：请用 gh_commit 提交。',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo 形式，必须是已克隆到工作区的仓库。' },
        action: { type: 'string', required: true, description: 'get（读文件）、list（列目录）、put（整份写入/新建）、edit（精确替换）。' },
        path: { type: 'string', description: '仓库内相对路径。get/list/put/edit 都必填（list 省略则列仓库根目录）。' },
        startLine: { type: 'integer', description: 'action=get 的起始行（1 起），默认 1。' },
        endLine: { type: 'integer', description: 'action=get 的结束行（含）。省略则从 startLine 起返回最多 400 行。' },
        content: { type: 'string', description: 'action=put 的完整文件内容。' },
        overwrite: { type: 'boolean', description: 'action=put 覆盖已存在文件时必须显式设为 true。' },
        oldText: { type: 'string', description: 'action=edit 要被替换的原文，必须与文件完全一致（含缩进）。' },
        newText: { type: 'string', description: 'action=edit 的替换文本，空字符串表示删除。' },
        count: { type: 'integer', description: 'action=edit 期望 oldText 出现的次数，默认 1；不匹配则拒绝修改。' },
      },
      async execute(args, exec) {
        if (args.action !== 'list' && (typeof args.path !== 'string' || args.path === '')) {
          throw fail(`action=${args.action} 需要 path 参数（仓库内相对路径）。`)
        }
        const handler = fileAction[args.action]
        if (!handler) {
          throw fail(`不支持的 action "${args.action}"。可用：${Object.keys(fileAction).join(', ')}。`)
        }
        return handler(args, exec)
      },
    },

    commit: {
      name: 'gh_commit',
      description: [
        '在本地克隆里暂存改动并提交（默认只提交到本地）。paths 省略时提交全部改动。',
        '把 push 设为 true 可在同一步里提交并推送（需要插件配置 allowPush: true）。',
        '提交信息请写清楚“为什么改”，不要只写“update”。',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo 形式。' },
        message: { type: 'string', required: true, description: '提交信息（建议一行主题 + 空行 + 说明）。' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要提交的路径列表（仓库内相对路径）。省略或空数组表示全部改动。',
        },
        push: { type: 'boolean', description: '提交后是否立即推送（需要 allowPush: true）。默认 false。' },
        authorName: { type: 'string', description: '覆盖本次提交的作者名（省略用插件配置或 git 全局配置）。' },
        authorEmail: { type: 'string', description: '覆盖本次提交的作者邮箱。' },
      },
      execute: commitTool,
    },

    push: {
      name: 'gh_push',
      description: [
        '把本地提交推送到 origin。需要插件配置 allowPush: true，且 token 具备仓库写权限。',
        '推送前建议先 gh_repo action=status 确认要推的内容；远端有新提交时先 gh_pull。',
      ].join(' '),
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo 形式。' },
        branch: { type: 'string', description: '要推送到的远端分支名。省略表示当前分支推到同名远端分支。' },
        force: { type: 'boolean', description: '是否强推（仅 --force-with-lease，且需要 allowForcePush: true）。默认 false。' },
      },
      execute: pushTool,
    },

    pull: {
      name: 'gh_pull',
      description: '把远端改动拉到本地克隆。默认 --ff-only（分叉时明确失败而不是制造合并冲突），rebase: true 时改用 --rebase。',
      parameters: {
        repo: { type: 'string', required: true, description: 'owner/repo 形式。' },
        rebase: { type: 'boolean', description: '用 --rebase 代替 --ff-only。默认 false。' },
      },
      execute: pullTool,
    },

    account: {
      name: 'gh_account',
      description: [
        'GitHub 账号绑定管理。action=list 列出已绑定账号与当前默认账号；action=bind 绑定一个新账号（',
        '不传 token 时会弹出输入框让你粘贴 PAT，绑定后自动设为默认）；action=use 切换默认账号；',
        'action=remove 删除账号；action=status 查看当前生效的凭据来源与对应账号（不显示 token）。',
        '首次需要凭据时会自动弹出绑定引导；之后所有 gh_* 调用默认使用已绑定的账号。',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, description: 'bind（绑定）、list（列表）、use（切换）、remove（删除）、status（状态）。' },
        token: { type: 'string', description: 'action=bind 时的 PAT；省略则弹出输入框让用户粘贴。' },
        login: { type: 'string', description: 'action=use / action=remove 时的登录名或账号 id。' },
      },
      execute: accountTool,
    },

    config: {
      name: 'gh_config',
      description: [
        'GitHub 访问配置：action=status 查看 token 是否已配置、来自哪一层、对应哪个 GitHub 账号（不显示 token 本身）；',
        'action=set 把 PAT 存入 DSH 凭据服务；action=unset 删除。',
        '当 gh_* 报 401 或提示未配置凭据时，先让用户提供 PAT 再调用 action=set。',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, description: 'status（默认）、set（写入 token）、unset（删除 token）。' },
        token: { type: 'string', description: 'action=set 时的 GitHub Personal Access Token 明文。' },
      },
      execute: async args => configTool(args),
    },

    api: {
      name: 'gh_api',
      description: [
        '直接调用 GitHub REST API（只允许 api.github.com），用于 issue、PR、Actions、搜索等 gh_* 工具未覆盖的场景。',
        'GET/HEAD 为只读；POST/PATCH/PUT/DELETE 需要插件配置 allowApiWrite: true。',
        '仓库白名单（allowRepos）按 endpoint 里的 /repos/{owner}/{repo} 判定；endpoint 没有该路径段时用 repo 参数补充。',
        '结果以 JSON 返回并自动截断。',
      ].join(' '),
      parameters: {
        endpoint: { type: 'string', required: true, description: '以 / 开头的 API 路径，例如 /repos/owner/repo/pulls（查询参数放 query 里）。' },
        method: { type: 'string', description: 'GET（默认）、POST、PATCH、PUT、DELETE、HEAD。' },
        repo: { type: 'string', description: 'owner/repo，用于白名单校验；若与 endpoint 里的仓库不一致会被拒绝。' },
        query: { type: 'string', description: 'JSON 字符串形式的查询参数，例如 {"state":"open","per_page":20}。' },
        body: { type: 'string', description: 'JSON 字符串形式的请求体，例如 {"title":"...","head":"feature","base":"main"}。' },
      },
      execute: apiTool,
    },
  }
}
