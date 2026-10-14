/**
 * dsh-plugin-github — credential resolution layer
 *
 * Resolution order (first hit wins):
 *   1. **A bound GitHub account** (preferred) — see store.js. On first use it is bound through
 *      gh_account or the automatic prompt, and every call afterwards uses that account by default.
 *   2. The DSH credentials service ctx.credentials.resolve(ref) — for users who only ever stored a
 *      bare token and never went through the binding flow.
 *   3. Environment variables (config.tokenEnv / GITHUB_TOKEN / GH_TOKEN)
 *   4. .env.local / .env inside the host workspace (only when config.dotenv = true)
 *
 * No layer ever writes the token into a log; tool results contain only the source label and the
 * login name.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

export { DEFAULT_TOKEN_REF } from './store.js'
import { DEFAULT_TOKEN_REF, describeAccount, isValidTokenRef } from './store.js'

/** @type {Map<string, string>} */
const fileCache = new Map()

/** Minimal .env parsing: supports KEY=VALUE, an export prefix, # comments and single/double quotes. */
export function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!isValidTokenRef(key)) continue
    let value = withoutExport.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    // An empty value counts as absent, so a bare `KEY=` never looks like a stored credential.
    if (value !== '') out[key] = value
  }
  return out
}

async function readDotenvFile(file) {
  if (fileCache.has(file)) return fileCache.get(file)
  let value
  try {
    value = parseDotenv(await readFile(file, 'utf8'))
  } catch {
    value = undefined
  }
  fileCache.set(file, value)
  return value
}

/**
 * Resolve the token used to access GitHub.
 *
 * Order: bound account → environment-variable account fallback → bare token in the DSH credentials
 * service → environment variables → .env.
 * A bound account always takes precedence, so "use whichever account is bound" cannot be overridden
 * by a GITHUB_TOKEN that happens to exist in the environment.
 *
 * @param {{
 *   accounts?: import('./store.js').AccountManager,
 *   credentials?: {resolve?: (ref: string) => Promise<{value: string, source: string}|undefined>},
 *   tokenRef?: string,
 *   tokenEnv?: string,
 *   dotenv?: boolean,
 *   cwd?: string,
 *   allowEnvToken?: boolean,
 * }} context
 * @returns {Promise<{token?: string, source: string, configured: boolean, detail: string, login?: string, account?: import('./store.js').AccountRecord, viaEnvFallback?: boolean}>}
 */
export async function resolveToken(context) {
  const ref = isValidTokenRef(context.tokenRef) ? String(context.tokenRef) : DEFAULT_TOKEN_REF
  const tokenEnv = String(context.tokenEnv ?? 'GITHUB_TOKEN')
  const allowEnvToken = context.allowEnvToken !== false

  // 1) A bound account (preferred)
  if (context.accounts !== undefined) {
    try {
      const account = await context.accounts.active({ allowEnvToken })
      // An empty stored token counts as absent: otherwise a blank record would look like a bound
      // account and shadow the credentials service and environment fallbacks further down.
      if (account !== undefined && account.token !== '') {
        return {
          token: account.token,
          source: account.source ?? `account:${account.id}`,
          configured: true,
          login: account.login,
          account,
          ...(String(account.source ?? '').startsWith('env:') ? { viaEnvFallback: true } : {}),
          detail: `Using the bound GitHub account ${describeAccount(account)}`,
        }
      }
    } catch (error) {
      // A broken account store must not take the whole plugin down; keep falling back.
      return await envFallback(context, ref, tokenEnv,
        `Failed to read the bound account: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) A bare token in the DSH credentials service
  const provider = context.credentials
  if (provider && typeof provider.resolve === 'function') {
    try {
      const resolved = await provider.resolve(ref)
      if (resolved?.value) {
        return {
          token: resolved.value,
          source: `dsh-credentials(${resolved.source ?? 'managed'})`,
          configured: true,
          detail: `Read ${ref} from the DSH credentials service`,
        }
      }
    } catch (error) {
      return await envFallback(context, ref, tokenEnv,
        `Credentials service read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reason = context.accounts !== undefined
    ? 'no GitHub account is bound and the credentials service has none either'
    : (provider ? 'not configured in the credentials service' : 'the credentials service is not mounted')
  return await envFallback(context, ref, tokenEnv, reason)
}

async function envFallback(context, ref, tokenEnv, reason) {
  const env = process.env
  // Deduplicated, tried in order: tokenEnv, GITHUB_TOKEN, GH_TOKEN.
  const candidates = [...new Set([tokenEnv, 'GITHUB_TOKEN', 'GH_TOKEN', ref])]
  for (const name of candidates) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        token: value.trim(),
        source: `env:${name}`,
        configured: true,
        detail: `Read from the environment variable ${name} (${reason})`,
      }
    }
  }

  if (context.dotenv !== false && context.cwd) {
    for (const name of candidates) {
      for (const file of ['.env.local', '.env']) {
        const parsed = await readDotenvFile(path.join(context.cwd, file))
        const value = parsed?.[name]
        if (typeof value === 'string' && value !== '') {
          return {
            token: value,
            source: `${file}:${name}`,
            configured: true,
            detail: `Read ${name} from ${file} (${reason})`,
          }
        }
      }
    }
  }

  return {
    token: undefined,
    source: 'none',
    configured: false,
    detail: `${reason}; none of the environment variables ${candidates.join(' / ')} is set`,
  }
}

/**
 * Report the credential state only, never the value.
 * @param {Parameters<typeof resolveToken>[0] & {credentials?: any}} context
 */
export async function describeToken(context) {
  const ref = isValidTokenRef(context.tokenRef) ? String(context.tokenRef) : DEFAULT_TOKEN_REF
  const provider = context.credentials
  let service
  if (provider && typeof provider.describe === 'function') {
    try {
      service = await provider.describe(ref)
    } catch (error) {
      service = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const envNames = [String(context.tokenEnv ?? 'GITHUB_TOKEN'), 'GITHUB_TOKEN', 'GH_TOKEN']
  const present = envNames.filter(name => typeof process.env[name] === 'string' && process.env[name] !== '')
  const resolved = await resolveToken(context)
  return {
    ref,
    credentials_service: provider ? 'mounted' : 'absent',
    ...(service === undefined ? {} : { credentials_ref: service }),
    env_present: [...new Set(present)],
    effective_source: resolved.source,
    configured: resolved.configured,
    ...(resolved.login === undefined ? {} : { login: resolved.login }),
  }
}

/* ------------------------------------------------------------------ Writes: binding an account */

/**
 * Bind a token as an account (verify the identity first, then persist).
 * @param {{accounts?: import('./store.js').AccountManager, credentials?: any, tokenRef?: string}} context
 * @param {string} token
 * @param {{source?: string}} [meta]
 */
export async function bindAccount(context, token, meta) {
  if (context.accounts === undefined) {
    return {
      ok: false,
      detail: 'Account storage is unavailable, so the account cannot be bound. Instead, set the environment variable '
        + `${isValidTokenRef(context.tokenRef) ? context.tokenRef : DEFAULT_TOKEN_REF}.`,
    }
  }
  try {
    const record = await context.accounts.bind(token, meta)
    return {
      ok: true,
      account: record,
      detail: `Bound the GitHub account @${record.login} and set it as the current default.`,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Legacy interface: write the token straight into the DSH credentials reference. When account binding
 * is available, go through bindAccount instead.
 * @param {{credentials?: {set?: (ref: string, value: string) => Promise<void>}, tokenRef?: string}} context
 * @param {string} token
 */
export async function storeToken(context, token) {
  const ref = isValidTokenRef(context.tokenRef) ? String(context.tokenRef) : DEFAULT_TOKEN_REF
  const provider = context.credentials
  if (!provider || typeof provider.set !== 'function') {
    return {
      ok: false,
      detail:
        'The DSH credentials service (ctx.credentials) is currently unavailable, so the token cannot be written.'
        + ` Instead, set the environment variable ${ref} (for example export it before starting DSH, or put it in $DSH_HOME/.env).`,
    }
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, detail: 'The token must not be empty; to clear it use gh_config action=unset.' }
  }
  await provider.set(ref, token.trim())
  return { ok: true, detail: `Written to the DSH credentials service: ${ref} (the value never appears in any tool output)` }
}

/**
 * Delete the bare token from the DSH credentials service.
 * @param {{credentials?: {unset?: (ref: string) => Promise<void>}, tokenRef?: string}} context
 */
export async function clearToken(context) {
  const ref = isValidTokenRef(context.tokenRef) ? String(context.tokenRef) : DEFAULT_TOKEN_REF
  const provider = context.credentials
  if (!provider || typeof provider.unset !== 'function') {
    return { ok: false, detail: 'The DSH credentials service is unavailable, so the token cannot be deleted.' }
  }
  await provider.unset(ref)
  return { ok: true, detail: `Deleted from the DSH credentials service: ${ref}` }
}
