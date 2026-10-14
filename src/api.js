/**
 * dsh-plugin-github — GitHub REST 客户端（fetch 实现，无第三方依赖）
 *
 * 只负责 HTTP；授权判定留在工具层。绝不把 token 放进返回文本或错误消息。
 */

export const API_BASE = 'https://api.github.com'
export const DEFAULT_ACCEPT = 'application/vnd.github+json'
export const API_VERSION = '2022-11-28'

/** GitHub 建议的 User-Agent，缺失会被拒绝。 */
const USER_AGENT = 'dsh-plugin-github'

/**
 * 发起一次 GitHub API 请求。
 * @param {string} endpoint 以 / 开头的路径，例如 /repos/owner/repo
 * @param {{method?: string, token?: string, body?: unknown, query?: Record<string, string|number|boolean|undefined>, signal?: AbortSignal, accept?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, statusText: string, json?: unknown, text?: string, headers: Record<string,string>, rateLimit?: {remaining?: number, reset?: number}, error?: string}>}
 */
export async function githubRequest(endpoint, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    query,
    signal,
    accept = DEFAULT_ACCEPT,
    timeoutMs = 30_000,
  } = options

  const url = new URL(endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`)
  if (url.origin !== API_BASE) {
    return {
      ok: false, status: 0, statusText: 'BLOCKED', headers: {},
      error: `出于安全考虑，只允许访问 ${API_BASE}（收到 ${url.origin}）。`,
    }
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }

  const headers = {
    accept,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow',
    })

    const text = await response.text()
    const collected = {}
    for (const name of [
      'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-used',
      'x-oauth-scopes', 'x-accepted-oauth-scopes', 'link', 'retry-after',
    ]) {
      const value = response.headers.get(name)
      if (value) collected[name] = value
    }

    let json
    if (text !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }

    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: collected,
      ...(json === undefined ? { text: text.slice(0, 20_000) } : { json }),
      rateLimit: {
        remaining: collected['x-ratelimit-remaining'] === undefined ? undefined : Number(collected['x-ratelimit-remaining']),
        reset: collected['x-ratelimit-reset'] === undefined ? undefined : Number(collected['x-ratelimit-reset']),
      },
    }

    if (!response.ok) {
      const message = json && typeof json === 'object' && 'message' in json ? String(json.message) : response.statusText
      result.error = `GitHub API ${response.status} ${response.statusText}: ${message}`
      if (response.status === 401) {
        result.error += '\n（401：token 无效或未配置。可用 gh_config action=set 写入，或设置环境变量 GITHUB_TOKEN。）'
      }
      if (response.status === 403 && collected['x-ratelimit-remaining'] === '0') {
        result.error += '\n（403 且配额耗尽：等 x-ratelimit-reset 之后重试，或换用带更高配额的 token。）'
      }
    }
    return result
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false, status: 0, statusText: aborted ? 'ABORTED' : 'NETWORK', headers: {},
      error: aborted
        ? `请求被取消或超时（${timeoutMs}ms）：${method} ${url.pathname}`
        : `网络错误：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 把任意 JSON 压成适合放进模型上下文的紧凑文本。 */
export function compactJson(value, maxChars = 20_000) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符；请用更精确的查询参数缩小结果）`
}
