/**
 * dsh-plugin-github — GitHub 账号绑定存储
 *
 * 目标：第一次需要凭据时引导用户绑定一个 GitHub 账号并记住；之后所有调用默认用这个账号。
 *
 * 两个后端，按可用性自动选择：
 *
 *   1. `dsh-credentials`（首选）—— 用 DSH 官方凭据服务存 token。
 *      - 每个账号一条 record：key = `github-repo/account-<login>`，
 *        `{ kind: 'api-key', key: <PAT>, env: { GITHUB_LOGIN: <login> } }`
 *      - 当前账号指针：`github-repo/active`
 *      - record 的写入只能走 `modifyRecord`（官方唯一的写路径，带跨进程锁），
 *        `readRecord`/`listRecords`/`deleteRecord` 分别负责读、列举、删。
 *      - token 值不会被枚举出来：`listRecords()` 只返回 key 与 kind。
 *
 *   2. JSON 文件（回退）—— `$DSH_HOME/github-accounts.json`。
 *      插件拥有的文件，用于宿主没有挂载凭据服务的场景（本机就是这种）。
 *      POSIX 上按 0600 写入；Windows 无对应语义，靠用户目录权限兜底。
 *
 * 环境变量始终作为最后一层回退，不写入任何存储。
 *
 * 任何工具的返回值里都不会出现 token——`accountView()` 负责把内部记录投影成
 * 「可安全展示」的摘要。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** store 里 record 的 scope 段（凭据 key 必须是 `<scope>/<id>`）。 */
const RECORD_SCOPE = 'github-repo'
const ACTIVE_ID = 'active'

/** 账号 id 必须匹配凭据 key 段的语法：小写字母开头的短横线标识。 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 环境变量名（POSIX 标识符）语法，用于校验 tokenRef。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 默认的凭据引用名。 */
export const DEFAULT_TOKEN_REF = 'GITHUB_TOKEN'

/** 把登录名转成合法的 record id。 */
export function accountIdFor(login) {
  const id = String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (id === '' || !ID_PATTERN.test(id)) {
    throw new Error(`无法从登录名 "${login}" 生成合法的账号 id（只允许小写字母、数字、短横线）。`)
  }
  return id
}

/** record id → 凭据 key。 */
function recordKeyFor(id) {
  return `${RECORD_SCOPE}/${id}`
}

/** 解析 `<scope>/<id>` 形式的凭据 key。 */
function parseRecordKey(key) {
  const value = String(key ?? '')
  const slash = value.indexOf('/')
  if (slash <= 0) return undefined
  const scope = value.slice(0, slash)
  const id = value.slice(slash + 1)
  if (scope !== RECORD_SCOPE || !ID_PATTERN.test(id)) return undefined
  return id
}

/**
 * 内部账号记录。
 * @typedef {object} AccountRecord
 * @property {string} id 稳定的账号 id（= 登录名规范化的结果）
 * @property {string} login GitHub 登录名
 * @property {string} token PAT
 * @property {string} [name] 显示名（GitHub 的 name 字段）
 * @property {string} [scopes] token 的权限范围（x-oauth-scopes 响应头）
 * @property {string} [source] 这个账号是从哪里来的（供展示）
 * @property {string} [boundAt] 绑定时间（ISO 字符串）
 */

/**
 * 面向模型/用户的账号视图：**不含 token**。
 * @param {AccountRecord} record
 * @param {string | undefined} activeId
 */
export function accountView(record, activeId) {
  return {
    id: record.id,
    login: record.login,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.scopes === undefined || record.scopes === '' ? {} : { scopes: record.scopes }),
    ...(record.source === undefined ? {} : { source: record.source }),
    ...(record.boundAt === undefined ? {} : { bound_at: record.boundAt }),
    active: record.id === activeId,
  }
}

/* ------------------------------------------------------------------ 后端 1：DSH 凭据服务 */

/**
 * 基于 `ctx.credentials` 的存储。
 *
 * 只用服务上真实存在的成员，并且每一步都做能力检测——凭据服务在不同 DSH
 * 版本/组合下的实现并不一致，缺一个方法就应该干净地回退，而不是抛错。
 * @param {any} provider
 */
export function createCredentialsStore(provider) {
  const can = name => provider && typeof provider[name] === 'function'
  if (!can('listRecords') || !can('readRecord')) return undefined

  /** 读一条 record 并还原成 AccountRecord。 */
  const readAt = async id => {
    const record = await provider.readRecord(recordKeyFor(id))
    if (record === undefined || record === null) return undefined
    const login = record?.env?.GITHUB_LOGIN ?? id
    return {
      id,
      login,
      token: typeof record.key === 'string' ? record.key : '',
      ...(typeof record.env?.GITHUB_NAME === 'string' ? { name: record.env.GITHUB_NAME } : {}),
      ...(typeof record.env.GITHUB_SCOPES === 'string' ? { scopes: record.env.GITHUB_SCOPES } : {}),
      ...(typeof record.env.GITHUB_SOURCE === 'string' ? { source: record.env.GITHUB_SOURCE } : {}),
      ...(typeof record.env.GITHUB_BOUND_AT === 'string' ? { boundAt: record.env.GITHUB_BOUND_AT } : {}),
    }
  }

  return {
    kind: 'credentials',

    async list() {
      const entries = await provider.listRecords()
      const ids = []
      for (const entry of entries ?? []) {
        const id = parseRecordKey(entry?.key)
        if (id !== undefined && id !== ACTIVE_ID) ids.push(id)
      }
      const records = []
      for (const id of ids.sort()) {
        const record = await readAt(id)
        if (record !== undefined) records.push(record)
      }
      return records
    },

    async activeId() {
      if (!can('readRecord')) return undefined
      const record = await provider.readRecord(recordKeyFor(ACTIVE_ID))
      const id = record?.env?.ACTIVE
      return typeof id === 'string' && id !== '' ? id : undefined
    },

    async setActive(id) {
      if (!can('modifyRecord')) throw new Error('凭据服务不支持 modifyRecord，无法记录当前账号。')
      await provider.modifyRecord(recordKeyFor(ACTIVE_ID), async () => ({
        kind: 'api-key',
        env: { ACTIVE: id },
      }))
    },

    /**
     * @param {AccountRecord} record
     */
    async save(record) {
      if (!can('modifyRecord')) {
        throw new Error('凭据服务不支持 modifyRecord，无法保存账号。')
      }
      await provider.modifyRecord(recordKeyFor(record.id), async () => ({
        kind: 'api-key',
        key: record.token,
        env: {
          GITHUB_LOGIN: record.login,
          ...(record.name === undefined ? {} : { GITHUB_NAME: record.name }),
          ...(record.scopes === undefined ? {} : { GITHUB_SCOPES: record.scopes }),
          ...(record.source === undefined ? {} : { GITHUB_SOURCE: record.source }),
          ...(record.boundAt === undefined ? {} : { GITHUB_BOUND_AT: record.boundAt }),
        },
      }))
    },

    async remove(id) {
      if (!can('deleteRecord')) throw new Error('凭据服务不支持 deleteRecord，无法删除账号。')
      await provider.deleteRecord(recordKeyFor(id))
    },
  }
}

/* ------------------------------------------------------------------ 后端 2：JSON 文件 */

/**
 * 插件自有的 JSON 文件存储。
 * @param {string} file
 */
export function createFileStore(file) {
  /** @type {{version: number, active?: string, accounts: AccountRecord[]} | undefined} */
  let cache

  const load = async () => {
    if (cache !== undefined) return cache
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      cache = {
        version: 1,
        ...(typeof parsed?.active === 'string' ? { active: parsed.active } : {}),
        accounts: Array.isArray(parsed?.accounts) ? parsed.accounts.filter(isAccountRecord) : [],
      }
    } catch {
      // 文件不存在或损坏：当作空存储。损坏时不覆盖用户内容——只有写入时才落盘。
      cache = { version: 1, accounts: [] }
    }
    return cache
  }

  const persist = async state => {
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    await writeFile(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf8')
    await chmod(temp, 0o600).catch(() => {})
    await rename(temp, file)
    cache = state
  }

  return {
    kind: 'file',
    file,

    async list() {
      const state = await load()
      return state.accounts.map(account => ({ ...account }))
    },

    async activeId() {
      const state = await load()
      return state.active
    },

    async setActive(id) {
      const state = await load()
      await persist({ ...state, active: id })
    },

    /** @param {AccountRecord} record */
    async save(record) {
      const state = await load()
      const accounts = state.accounts.filter(account => account.id !== record.id)
      accounts.push({ ...record })
      accounts.sort((a, b) => a.id.localeCompare(b.id))
      await persist({ ...state, accounts, active: record.id })
    },

    async remove(id) {
      const state = await load()
      const accounts = state.accounts.filter(account => account.id !== id)
      const active = state.active === id ? undefined : state.active
      await persist({
        version: 1,
        accounts,
        ...(active === undefined ? {} : { active }),
      })
    },
  }
}

function isAccountRecord(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.login === 'string'
    && typeof value.token === 'string'
}

/* ------------------------------------------------------------------ 选择后端 */

/**
 * 选择可用的存储后端。
 * @param {{credentials?: unknown, dshHome?: string, file?: string}} options
 * @returns {{store: any, reason: string}}
 */
export function selectStore(options) {
  const credentialsStore = createCredentialsStore(options.credentials)
  if (credentialsStore !== undefined) {
    return { store: credentialsStore, reason: 'dsh-credentials' }
  }
  const file = options.file ?? path.join(options.dshHome ?? '.', 'github-accounts.json')
  return {
    store: createFileStore(file),
    reason: `file:${file}（DSH 凭据服务未挂载，改用插件自有的账号文件）`,
  }
}

/* ------------------------------------------------------------------ 账号管理 */

/**
 * @typedef {object} AccountManager
 * @property {() => Promise<ReturnType<typeof accountView>[]>} list
 * @property {() => Promise<AccountRecord | undefined>} active
 * @property {(token: string, meta?: object) => Promise<AccountRecord>} bind
 * @property {(idOrLogin: string) => Promise<AccountRecord>} use
 * @property {(idOrLogin: string) => Promise<{id: string, wasActive: boolean}>} remove
 * @property {() => Promise<string | undefined>} activeId
 * @property {string} backend
 */

/**
 * 造一个账号管理器。
 *
 * @param {{
 *   store: any,
 *   envToken?: {name: string, value: string},
 *   lookupIdentity: (token: string) => Promise<{login: string, name?: string, scopes?: string}>,
 * }} options
 * @returns {AccountManager}
 */
export function createAccountManager(options) {
  const { store, lookupIdentity } = options
  const envToken = options.envToken

  const find = async idOrLogin => {
    const all = await store.list()
    const wanted = String(idOrLogin ?? '').trim().toLowerCase()
    return all.find(account => account.id === wanted || account.login.toLowerCase() === wanted)
  }

  /**
   * 当前生效的账号。
   *
   * 只有**真正绑定过的账号**才会在这里返回。环境变量里的 token 刻意不算「已绑定」：
   * 用户绑定了一个账号，就应该默认用那个账号，而不是被环境里恰好存在的
   * GITHUB_TOKEN 盖掉。环境变量只在「一个账号都没绑」时作为最后一层回退出现，
   * 那时 gh_account status 会把来源标成 env:…，引导文案也据此判断是否该弹窗。
   *
   * @param {{allowEnvToken?: boolean}} [options] allowEnvToken=false 时忽略环境变量回退
   */
  const activeRecord = async (options = {}) => {
    const id = await store.activeId()
    if (id !== undefined) {
      const record = (await store.list()).find(account => account.id === id)
      if (record !== undefined) return record
    }
    const all = await store.list()
    // 没有指针但只有一个绑定账号 → 直接用它，避免每次都要显式 use。
    if (all.length === 1) return all[0]
    if (all.length === 0 && options.allowEnvToken !== false
      && envToken !== undefined && envToken.value !== '') {
      try {
        const identity = await lookupIdentity(envToken.value)
        return {
          id: accountIdFor(identity.login),
          login: identity.login,
          token: envToken.value,
          ...(identity.name === undefined ? {} : { name: identity.name }),
          ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
          source: `env:${envToken.name}`,
        }
      } catch {
        // 环境变量里的 token 无效：不要让整个插件不可用，交给调用方按「未绑定」处理。
        return undefined
      }
    }
    return undefined
  }

  return {
    backend: store.kind,

    async activeId() {
      const record = await activeRecord()
      return record?.id
    },

    async active(options) {
      return await activeRecord(options)
    },

    /** 只统计「真正绑定过」的账号（不含环境变量回退）。 */
    async boundCount() {
      return (await store.list()).length
    },

    async list() {
      const all = (await store.list()).map(account => ({ ...account }))
      const activeId = (await activeRecord())?.id
      return all.map(account => ({ ...account, __active: account.id === activeId }))
    },

    /**
     * 绑定一个 token：先向 GitHub 确认身份，成功后才落盘。
     * @param {string} token
     * @param {{source?: string}} [meta]
     */
    async bind(token, meta = {}) {
      const value = String(token ?? '').trim()
      if (value === '') throw new Error('token 不能为空。')
      const identity = await lookupIdentity(value)
      /** @type {AccountRecord} */
      const record = {
        id: accountIdFor(identity.login),
        login: identity.login,
        token: value,
        ...(identity.name === undefined ? {} : { name: identity.name }),
        ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
        ...(meta.source === undefined ? {} : { source: meta.source }),
        boundAt: new Date().toISOString(),
      }
      await store.save(record)
      await store.setActive(record.id)
      return record
    },

    /**
     * 切换当前账号。
     * @param {string} idOrLogin
     */
    async use(idOrLogin) {
      const record = await find(idOrLogin)
      if (record === undefined) {
        const all = await store.list()
        const known = all.map(account => account.login).join(', ')
        throw new Error(
          `找不到账号 "${idOrLogin}"。`
          + (known === '' ? '当前还没有绑定任何账号，请先用 action=bind 绑定。' : `已绑定的账号：${known}。`),
        )
      }
      await store.setActive(record.id)
      return record
    },

    /**
     * 删除账号。
     * @param {string} idOrLogin
     */
    async remove(idOrLogin) {
      const record = await find(idOrLogin)
      if (record === undefined) throw new Error(`找不到账号 "${idOrLogin}"，无需删除。`)
      const wasActive = (await store.activeId()) === record.id
      await store.remove(record.id)
      return { id: record.id, wasActive }
    },
  }
}

/** 供 index.js 校验 tokenRef 用。 */
export function isValidTokenRef(value) {
  return REF_PATTERN.test(String(value ?? ''))
}

/** 当前账号的展示标签（不含 token）。 */
export function describeAccount(record) {
  if (record === undefined) return '未绑定'
  return `@${record.login}${record.source === undefined ? '' : `（来源 ${record.source}）`}`
}
