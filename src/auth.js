/**
 * dsh-plugin-github — 凭据解析层
 *
 * 解析顺序（第一个命中的胜出）：
 *   1. **已绑定的 GitHub 账号**（首选）—— 见 store.js。首次使用时通过 gh_account
 *      或自动引导绑定，之后所有调用默认用这个账号。
 *   2. DSH 凭据服务 ctx.credentials.resolve(ref) —— 兼容只写了一个 token、没走绑定流程的用户。
 *   3. 环境变量（config.tokenEnv / GITHUB_TOKEN / GH_TOKEN）
 *   4. 宿主工作区内的 .env.local / .env（仅当 config.dotenv = true）
 *
 * 任何一层都不会把 token 写进日志；工具结果里只出现来源标签与登录名。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

export { DEFAULT_TOKEN_REF } from './store.js'
import { DEFAULT_TOKEN_REF, describeAccount, isValidTokenRef } from './store.js'

/** @type {Map<string, string>} */
const fileCache = new Map()

/** 极简 .env 解析：支持 KEY=VALUE、export 前缀、# 注释、单双引号。 */
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
 * 解析用于访问 GitHub 的 token。
 *
 * 顺序：已绑定账号 → 环境变量形式的账号回退 → DSH 凭据服务里的裸 token → 环境变量 → .env。
 * 绑定账号永远优先，这样「绑定了谁就用谁」不会被环境里恰好存在的 GITHUB_TOKEN 盖掉。
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

  // 1) 已绑定的账号（首选）
  if (context.accounts !== undefined) {
    try {
      const account = await context.accounts.active({ allowEnvToken })
      if (account !== undefined && account.token !== '') {
        return {
          token: account.token,
          source: account.source ?? `account:${account.id}`,
          configured: true,
          login: account.login,
          account,
          ...(String(account.source ?? '').startsWith('env:') ? { viaEnvFallback: true } : {}),
          detail: `已使用绑定的 GitHub 账号 ${describeAccount(account)}`,
        }
      }
    } catch (error) {
      // 账号存储坏了不应该让整个插件不可用，继续往下回退。
      return await envFallback(context, ref, tokenEnv,
        `读取已绑定账号失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) DSH 凭据服务里的裸 token
  const provider = context.credentials
  if (provider && typeof provider.resolve === 'function') {
    try {
      const resolved = await provider.resolve(ref)
      if (resolved?.value) {
        return {
          token: resolved.value,
          source: `dsh-credentials(${resolved.source ?? 'managed'})`,
          configured: true,
          detail: `已从 DSH 凭据服务读取 ${ref}`,
        }
      }
    } catch (error) {
      return await envFallback(context, ref, tokenEnv,
        `凭据服务读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reason = context.accounts !== undefined
    ? '尚未绑定 GitHub 账号，凭据服务里也没有'
    : (provider ? '凭据服务中未配置' : '凭据服务未挂载')
  return await envFallback(context, ref, tokenEnv, reason)
}

async function envFallback(context, ref, tokenEnv, reason) {
  const env = process.env
  // 去重后逐个尝试：tokenEnv、GITHUB_TOKEN、GH_TOKEN。
  const candidates = [...new Set([tokenEnv, 'GITHUB_TOKEN', 'GH_TOKEN', ref])]
  for (const name of candidates) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        token: value.trim(),
        source: `env:${name}`,
        configured: true,
        detail: `已从环境变量 ${name} 读取（${reason}）`,
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
            detail: `已从 ${file} 读取 ${name}（${reason}）`,
          }
        }
      }
    }
  }

  return {
    token: undefined,
    source: 'none',
    configured: false,
    detail: `${reason}；环境变量 ${candidates.join(' / ')} 均未设置`,
  }
}

/**
 * 只报告凭据状态，绝不返回值。
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

/* ------------------------------------------------------------------ 写入：绑定账号 */

/**
 * 把一个 token 绑定成账号（先校验身份，再落盘）。
 * @param {{accounts?: import('./store.js').AccountManager, credentials?: any, tokenRef?: string}} context
 * @param {string} token
 * @param {{source?: string}} [meta]
 */
export async function bindAccount(context, token, meta) {
  if (context.accounts === undefined) {
    return {
      ok: false,
      detail: '账号存储不可用，无法绑定。可改为设置环境变量 '
        + `${isValidTokenRef(context.tokenRef) ? context.tokenRef : DEFAULT_TOKEN_REF}。`,
    }
  }
  try {
    const record = await context.accounts.bind(token, meta)
    return {
      ok: true,
      account: record,
      detail: `已绑定 GitHub 账号 @${record.login}，并设为当前默认账号。`,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 兼容旧接口：把 token 直接写进 DSH 凭据服务的引用。账号绑定可用时应走 bindAccount。
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
        'DSH 凭据服务（ctx.credentials）当前不可用，无法写入 token。'
        + `可改为设置环境变量 ${ref}（例如在启动 DSH 前 export，或写进 $DSH_HOME/.env）。`,
    }
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, detail: 'token 不能为空；要清除请用 gh_config 的 action=unset。' }
  }
  await provider.set(ref, token.trim())
  return { ok: true, detail: `已写入 DSH 凭据服务：${ref}（值不会出现在任何工具输出中）` }
}

/**
 * 从 DSH 凭据服务删除裸 token。
 * @param {{credentials?: {unset?: (ref: string) => Promise<void>}, tokenRef?: string}} context
 */
export async function clearToken(context) {
  const ref = isValidTokenRef(context.tokenRef) ? String(context.tokenRef) : DEFAULT_TOKEN_REF
  const provider = context.credentials
  if (!provider || typeof provider.unset !== 'function') {
    return { ok: false, detail: 'DSH 凭据服务不可用，无法删除 token。' }
  }
  await provider.unset(ref)
  return { ok: true, detail: `已从 DSH 凭据服务删除：${ref}` }
}
