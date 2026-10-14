/**
 * dsh-plugin-github — GitHub REST client (fetch implementation, no third-party dependencies)
 *
 * Only handles HTTP; authorization decisions stay in the tool layer. The token is never placed in
 * returned text or error messages.
 */

export const API_BASE = 'https://api.github.com'
export const DEFAULT_ACCEPT = 'application/vnd.github+json'
export const API_VERSION = '2022-11-28'

/** The User-Agent GitHub recommends; requests without one are rejected. */
const USER_AGENT = 'dsh-plugin-github'

/**
 * Make one GitHub API request.
 * @param {string} endpoint Path starting with /, for example /repos/owner/repo
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
      error: `For security reasons only ${API_BASE} may be accessed (received ${url.origin}).`,
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
        result.error += '\n(401: the token is invalid or not configured. Store one with gh_config action=set, or set the GITHUB_TOKEN environment variable.)'
      }
      if (response.status === 403 && collected['x-ratelimit-remaining'] === '0') {
        result.error += '\n(403 with the quota exhausted: retry after x-ratelimit-reset, or switch to a token with a higher quota.)'
      }
    }
    return result
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false, status: 0, statusText: aborted ? 'ABORTED' : 'NETWORK', headers: {},
      error: aborted
        ? `Request aborted or timed out (${timeoutMs}ms): ${method} ${url.pathname}`
        : `Network error: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** Flatten arbitrary JSON into compact text suitable for the model context. */
export function compactJson(value, maxChars = 20_000) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (truncated: ${text.length} characters in total; narrow the result with more precise query parameters)`
}
