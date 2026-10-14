/**
 * dsh-plugin-github — plugin entry point
 *
 * Wires GitHub repository read/write into DeepSeek Harness: clone / read files / edit files /
 * commit / push / REST API.
 *
 * Registration: build a raw JSON-Schema-shaped ToolDefinition and hand it to ctx.tools.register().
 * This is a path dsh-tools explicitly supports (MCP tools take it too), therefore:
 *   - No DSH package needs to be imported at module load ⇒ the plugin cannot fail to load because
 *     a package cannot be resolved
 *   - No TypeScript build step is needed; it works as soon as it is installed
 * A tool definition must declare output: { schema, render }, where schema uses the "annotation only"
 * form (this plugin's tools return heterogeneous JSON such as objects and strings, so an annotation
 * schema means "any JSON value").
 */

import path from 'node:path'
import { assertAllowRules, normalizeConfig } from './repos.js'
import { resolveToken } from './auth.js'
import { createAccountManager, describeAccount, selectStore } from './store.js'
import { buildToolSpecs } from './tools.js'
import { githubRequest } from './api.js'

export const name = 'github-repo'

/** Only the tool registry is required; the credentials service is fetched optionally via ctx.get. */
export const inject = ['tools']

/** Unknown config keys must be reported, so a user writing allowPushes instead of allowPush notices. */
const KNOWN_CONFIG_KEYS = new Set([
  'workspaceRoot', 'allowRepos', 'allowPush', 'allowForcePush', 'allowApiWrite',
  'allowApiReadOutsideAllowlist', 'allowNonGithubRemotes',
  'tokenRef', 'tokenEnv', 'dotenv', 'commandTimeoutMs', 'maxDiffChars', 'maxReadChars',
  'gitAuthorName', 'gitAuthorEmail',
  'allowAutoBind', 'promptForToken', 'accountStorePath',
])

/** Parameter declarations (this plugin's simplified DSL) → the supported JSON Schema subset. */
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
    // Keep the parameter root open: the model occasionally sending one extra field must not fail the whole call.
    additionalProperties: true,
  }
}

/** Model-visible text: strings are returned as-is, any other value is formatted as JSON. */
function renderValue(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value === undefined || value === null) return [{ type: 'text', text: '(no result)' }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** On the raw registration path, do the argument validation (type + required) ourselves. */
function validateArgs(spec, args) {
  const problems = []
  for (const [key, node] of Object.entries(spec.parameters ?? {})) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (node.required === true) problems.push(`missing required parameter ${key}`)
      continue
    }
    const actual = Array.isArray(value) ? 'array' : typeof value
    const expected = node.type === 'integer' ? 'number' : node.type
    if (expected === 'number' && actual !== 'number') problems.push(`${key} must be a number, received ${actual}`)
    else if (expected === 'array' && actual !== 'array') problems.push(`${key} must be an array, received ${actual}`)
    else if (expected !== 'number' && expected !== 'array' && actual !== expected) {
      problems.push(`${key} must be ${expected}, received ${actual}`)
    }
    if (node.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      problems.push(`${key} must be an integer`)
    }
    if (node.type === 'array' && Array.isArray(value) && node.items?.type !== undefined) {
      const itemType = node.items.type === 'integer' ? 'number' : node.items.type
      if (value.some(entry => (Array.isArray(entry) ? 'array' : typeof entry) !== itemType)) {
        problems.push(`every element of ${key} must be ${itemType}`)
      }
    }
  }
  return problems
}

/** Tool definition: parameters (JSON Schema) + output (annotation schema + render) + execute (returns the raw value). */
function buildDefinition(spec, host) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toJsonSchemaParameters(spec),
    output: {
      // An annotation-only schema = an unconstrained JSON value; these tools return heterogeneous results.
      schema: { description: `Structured result of ${spec.name}` },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      const safeArgs = args ?? {}
      const problems = validateArgs(spec, safeArgs)
      if (problems.length > 0) {
        throw new Error(`Argument validation failed (${spec.name}): ${problems.join('; ')}`)
      }
      const signal = exec?.signal instanceof AbortSignal ? exec.signal : undefined
      // The agent must be passed through to the tool: the first-use binding prompt is only accepted
      // when it carries "the Agent that is asking".
      const agent = exec?.agent ?? host.currentAgent?.()
      return spec.execute(safeArgs, { ...(exec ?? {}), signal, credentials: host.credentials, agent })
    },
  }
}

/** DSH home: both the account file and .credentials.yaml live here. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME
  return typeof home === 'string' && home !== '' ? path.join(home, '.dsh') : '.dsh'
}

/**
 * Look up the GitHub identity behind a token. The token must be confirmed valid before binding,
 * rather than storing a mistyped token.
 * @param {string} token
 */
async function lookupIdentity(token) {
  const response = await githubRequest('/user', { token })
  if (!response.ok) {
    const detail = response.error ?? `HTTP ${response.status}`
    throw new Error(`Token verification failed: ${detail}`)
  }
  const body = /** @type {{login?: string, name?: string}} */ (response.json ?? {})
  if (typeof body.login !== 'string' || body.login === '') {
    throw new Error('Token verification failed: /user returned no login (the token may lack permission to read the user).')
  }
  return {
    login: body.login,
    ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
    ...(typeof response.headers['x-oauth-scopes'] === 'string' ? { scopes: response.headers['x-oauth-scopes'] } : {}),
  }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const raw = config ?? {}
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      ctx.logger?.warn?.(
        'github-repo: unknown config key "%s" (ignored). Available config: %s',
        key,
        [...KNOWN_CONFIG_KEYS].join(', '),
      )
    }
  }

  const cfg = normalizeConfig(raw, process.cwd())
  // Invalid allowlist rules fail at load time instead of only when the model makes a call.
  assertAllowRules(cfg)

  const credentials = ctx.get('credentials')
  const userQuestions = ctx.get('userQuestions')
  const agents = ctx.get('agents')

  // Account storage: prefer the DSH credentials service, then the plugin's own JSON file.
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
    'github-repo: registered %d tools (%s); workspaceRoot=%s; allowPush=%s; allowApiWrite=%s; account store=%s',
    registered.length,
    registered.join(', '),
    cfg.workspaceRoot,
    cfg.allowPush,
    cfg.allowApiWrite,
    reason,
  )

  // Best-effort extremely short runtime context, so the model knows the boundaries and the current account.
  // If ctx.systemPrompt.context has no declarative interface, skip silently (tool availability is unaffected).
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
      'github-repo: skipping system prompt context injection (%s).',
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
  // Refresh the account information in the context after binding or switching accounts.
  stateRefresh = refresh
}

/** Fetch the Agent that initiated the current call (the binding prompt must be asked by it). */
function safeCurrentAgent(agents) {
  try {
    return typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined
  } catch {
    return undefined
  }
}

/** Module level: the most recently resolved credential state (only the source is kept, never the value). */
let tokenState

/** Module level: callback that refreshes the account context (wired up in apply). */
let stateRefresh

/**
 * Test-only: reset the module-level state so the same module instance can be applied repeatedly.
 * With this, tests do not need cache-busting query strings — which would load a second instance of
 * the dependencies.
 */
export function __resetForTests() {
  tokenState = undefined
  stateRefresh = undefined
}

/** Build the short note injected into the system prompt. */
function githubRuntimeContext(cfg, state) {
  const account = state?.account
  return [
    '## GitHub plugin (github-repo) is enabled',
    `- Local root: ${cfg.workspaceRoot} (every gh_* path is confined to this directory)`,
    `- Remote-write switches: allowPush=${cfg.allowPush}, allowForcePush=${cfg.allowForcePush}, allowApiWrite=${cfg.allowApiWrite}`,
    `- Repository allowlist: ${cfg.allowRepos.length === 0 ? 'not restricted by repository name' : cfg.allowRepos.join(', ')}`,
    `- GitHub account: ${state?.configured ? `${describeAccount(account)} (source ${state.source})` : 'not bound yet; when credentials are needed the binding prompt appears automatically, or call gh_account action=bind directly'}`,
    '- Typical flow: gh_account(action=bind/status) → gh_repo(action=clone) → gh_file → gh_commit → gh_push',
  ].join('\n')
}

export { summarizeConfig } from './repos.js'
