/**
 * dsh-plugin-github — 插件入口
 *
 * 把 GitHub 仓库读写接进 DeepSeek Harness：clone / 读文件 / 改文件 / 提交 / 推送 / REST API。
 *
 * 注册方式：直接构造原始 JSON Schema 形态的 ToolDefinition 交给 ctx.tools.register()。
 * 这是 dsh-tools 明确支持的路径（MCP 工具就走这条），因此：
 *   - 模块加载期 import 任何 DSH 包 ⇒ 不需要，插件不会因为解析不到包而加载失败
 *   - 不需要 TypeScript 构建步骤，装完即用
 * 工具定义必须声明 output：{ schema, render }，其中 schema 用「纯注解」形式
 * （本插件的工具返回对象/字符串等异构 JSON，注解 schema 表示「任意 JSON 值」）。
 */

import path from 'node:path'
import { assertAllowRules, normalizeConfig } from './repos.js'
import { resolveToken } from './auth.js'
import { createAccountManager, describeAccount, selectStore } from './store.js'
import { buildToolSpecs } from './tools.js'
import { githubRequest } from './api.js'

export const name = 'github-repo'

/** 只要求工具注册表；凭据服务用 ctx.get 可选获取。 */
export const inject = ['tools']

/** 未知配置键要报出来，避免用户把 allowPush 写成 allowPushes 却毫无反应。 */
const KNOWN_CONFIG_KEYS = new Set([
  'workspaceRoot', 'allowRepos', 'allowPush', 'allowForcePush', 'allowApiWrite',
  'allowApiReadOutsideAllowlist', 'allowNonGithubRemotes',
  'tokenRef', 'tokenEnv', 'dotenv', 'commandTimeoutMs', 'maxDiffChars', 'maxReadChars',
  'gitAuthorName', 'gitAuthorEmail',
  'allowAutoBind', 'promptForToken', 'accountStorePath',
])

/** 参数声明（本插件的简化 DSL）→ 受支持的 JSON Schema 子集。 */
function toJsonSchemaParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...rest } = node
    const { items, ...scalar } = rest
    properties[key] = items === undefined ? { ...scalar } : { ...scalar, items: { ...items } }
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    // 参数根保持开放：模型偶尔多带一个字段不该让整次调用失败。
    additionalProperties: true,
  }
}

/** 模型可见文本：字符串原样返回，其它值格式化成 JSON。 */
function renderValue(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value === undefined || value === null) return [{ type: 'text', text: '(无结果)' }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** 原始注册路径下自己做一遍参数校验（类型 + 必填）。 */
function validateArgs(spec, args) {
  const problems = []
  for (const [key, node] of Object.entries(spec.parameters ?? {})) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (node.required === true) problems.push(`缺少必填参数 ${key}`)
      continue
    }
    const actual = Array.isArray(value) ? 'array' : typeof value
    const expected = node.type === 'integer' ? 'number' : node.type
    if (expected === 'number' && actual !== 'number') problems.push(`${key} 应为 number，收到 ${actual}`)
    else if (expected === 'array' && actual !== 'array') problems.push(`${key} 应为 array，收到 ${actual}`)
    else if (expected !== 'number' && expected !== 'array' && actual !== expected) {
      problems.push(`${key} 应为 ${expected}，收到 ${actual}`)
    }
    if (node.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      problems.push(`${key} 应为整数`)
    }
    if (node.type === 'array' && Array.isArray(value) && node.items?.type !== undefined) {
      const itemType = node.items.type === 'integer' ? 'number' : node.items.type
      if (value.some(entry => (Array.isArray(entry) ? 'array' : typeof entry) !== itemType)) {
        problems.push(`${key} 的元素应全部是 ${itemType}`)
      }
    }
  }
  return problems
}

/** 工具定义：parameters（JSON Schema）+ output（注解 schema + render）+ execute（返回原始值）。 */
function buildDefinition(spec, host) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toJsonSchemaParameters(spec),
    output: {
      // 纯注解 schema = 不受约束的 JSON 值；这些工具返回对象/字符串等异构结果。
      schema: { description: `${spec.name} 的结构化结果` },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      const safeArgs = args ?? {}
      const problems = validateArgs(spec, safeArgs)
      if (problems.length > 0) {
        throw new Error(`参数校验失败（${spec.name}）：${problems.join('；')}`)
      }
      const signal = exec?.signal instanceof AbortSignal ? exec.signal : undefined
      // agent 要透传给工具：首次使用的绑定引导必须带上「提问的那个 Agent」才会被接受。
      const agent = exec?.agent ?? host.currentAgent?.()
      return spec.execute(safeArgs, { ...(exec ?? {}), signal, credentials: host.credentials, agent })
    },
  }
}

/** DSH home：账号文件与 .credentials.yaml 都放在这里。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME
  return typeof home === 'string' && home !== '' ? path.join(home, '.dsh') : '.dsh'
}

/**
 * 查一个 token 对应的 GitHub 身份。绑定前必须先确认 token 有效，
 * 而不是把一个打错的 token 存进去。
 * @param {string} token
 */
async function lookupIdentity(token) {
  const response = await githubRequest('/user', { token })
  if (!response.ok) {
    const detail = response.error ?? `HTTP ${response.status}`
    throw new Error(`token 校验失败：${detail}`)
  }
  const body = /** @type {{login?: string, name?: string}} */ (response.json ?? {})
  if (typeof body.login !== 'string' || body.login === '') {
    throw new Error('token 校验失败：/user 没有返回 login（token 可能缺少读取用户的权限）。')
  }
  return {
    login: body.login,
    ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
    ...(typeof response.headers['x-oauth-scopes'] === 'string' ? { scopes: response.headers['x-oauth-scopes'] } : {}),
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const raw = config ?? {}
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      ctx.logger?.warn?.(
        'github-repo: 未知配置项 "%s"（已忽略）。可用配置：%s',
        key,
        [...KNOWN_CONFIG_KEYS].join(', '),
      )
    }
  }

  const cfg = normalizeConfig(raw, process.cwd())
  // 非法白名单规则在加载期就失败，而不是等到模型发起调用时才报错。
  assertAllowRules(cfg)

  const credentials = ctx.get('credentials')
  const userQuestions = ctx.get('userQuestions')
  const agents = ctx.get('agents')

  // 账号存储：优先 DSH 凭据服务，其次插件自有的 JSON 文件。
  const { store, reason } = selectStore({
    credentials,
    dshHome: resolveDshHome(),
    ...(typeof cfg.accountStorePath === 'string' && cfg.accountStorePath !== ''
      ? { file: cfg.accountStorePath }
      : {}),
  })
  const envTokenName = cfg.tokenEnv
  const envTokenValue = (() => {
    for (const name of [envTokenName, 'GITHUB_TOKEN', 'GH_TOKEN']) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim() !== '') return { name, value: value.trim() }
    }
    return undefined
  })()

  const accounts = createAccountManager({
    store,
    ...(envTokenValue === undefined ? {} : { envToken: envTokenValue }),
    lookupIdentity,
  })

  const host = {
    credentials,
    userQuestions,
    accounts,
    envToken: envTokenValue,
    envTokenName: envTokenName,
    ...(agents === undefined ? {} : { currentAgent: () => safeCurrentAgent(agents) }),
  }

  const specs = Object.values(buildToolSpecs({
    config: cfg,
    host: {
      ...host,
      agents,
    },
  }))

  const registered = []
  for (const spec of specs) {
    ctx.tools.register(buildDefinition(spec, host))
    registered.push(spec.name)
  }

  ctx.logger?.info?.(
    'github-repo: 已注册 %d 个工具（%s）；workspaceRoot=%s；allowPush=%s；allowApiWrite=%s；账号存储=%s',
    registered.length,
    registered.join(', '),
    cfg.workspaceRoot,
    cfg.allowPush,
    cfg.allowApiWrite,
    reason,
  )

  // 尽力提供一段极短的运行态上下文，让模型知道边界与当前账号。
  // ctx.systemPrompt.context 的入参形态若无声明式接口则静默跳过（不影响工具可用性）。
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      const disposer = systemPrompt.context({
        name: 'github-repo',
        order: 900,
        text: () => githubRuntimeContext(cfg, tokenState),
      })
      if (typeof disposer === 'function') ctx.effect?.(() => disposer)
    }
  } catch (error) {
    ctx.logger?.debug?.(
      'github-repo: 跳过 system prompt 上下文注入（%s）。',
      error instanceof Error ? error.message : String(error),
    )
  }

  const refresh = () => {
    void resolveToken({
      accounts,
      credentials,
      tokenRef: cfg.tokenRef,
      tokenEnv: cfg.tokenEnv,
      dotenv: cfg.dotenv,
      cwd: cfg.workspaceRoot,
    }).then(state => {
      tokenState = state
    }).catch(() => {})
  }

  refresh()
  // 绑定/切换账号后刷新一次上下文里的账号信息。
  stateRefresh = refresh
}

/** 取当前发起调用的 Agent（绑定引导必须由它提问）。 */
function safeCurrentAgent(agents) {
  try {
    return typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined
  } catch {
    return undefined
  }
}

/** 模块级：最近一次解析到的凭据状态（只保留来源，不保留值）。 */
let tokenState

/** 模块级：刷新账号上下文的回调（apply 时装配）。 */
let stateRefresh

/**
 * 仅用于测试：重置模块级状态，让同一个模块实例可以反复 apply。
 * 有了它，测试就不需要靠查询串做缓存破坏——那会把依赖加载成第二份实例。
 */
export function __resetForTests() {
  tokenState = undefined
  stateRefresh = undefined
}

/** 生成注入 system prompt 的简短说明。 */
function githubRuntimeContext(cfg, state) {
  const account = state?.account
  return [
    '## GitHub 插件（github-repo）已启用',
    `- 本地根目录：${cfg.workspaceRoot}（所有 gh_* 路径都限制在此目录内）`,
    `- 写远端开关：allowPush=${cfg.allowPush}，allowForcePush=${cfg.allowForcePush}，allowApiWrite=${cfg.allowApiWrite}`,
    `- 仓库白名单：${cfg.allowRepos.length === 0 ? '未按仓库名限制' : cfg.allowRepos.join(', ')}`,
    `- GitHub 账号：${state?.configured ? `${describeAccount(account)}（来源 ${state.source}）` : '尚未绑定；需要凭据时会自动弹出绑定引导，也可直接调用 gh_account action=bind'}`,
    '- 典型流程：gh_account(action=bind/status) → gh_repo(action=clone) → gh_file → gh_commit → gh_push',
  ].join('\n')
}

export { summarizeConfig } from './repos.js'
