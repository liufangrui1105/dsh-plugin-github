/**
 * dsh-plugin-github — GitHub account binding storage
 *
 * Goal: on the first time credentials are needed, guide the user to bind a GitHub
 * account and remember it; every later call then uses that account by default.
 *
 * Two backends, chosen automatically by availability:
 *
 *   1. `dsh-credentials` (preferred) — stores the token in the official DSH
 *      credentials service.
 *      - One record per account: key = `github-repo/account-<login>`,
 *        `{ kind: 'api-key', key: <PAT>, env: { GITHUB_LOGIN: <login> } }`
 *      - Pointer to the current account: `github-repo/active`
 *      - Records may only be written through `modifyRecord` (the official, sole
 *        write path, which carries a cross-process lock); `readRecord`/
 *        `listRecords`/`deleteRecord` handle reading, listing and deleting.
 *      - Token values are never enumerable: `listRecords()` returns only key and
 *        kind.
 *
 *   2. JSON file (fallback) — `$DSH_HOME/github-accounts.json`.
 *      A file owned by the plugin, for hosts that have not mounted a credentials
 *      service (which is the case on this machine). Written with mode 0600 on
 *      POSIX; Windows has no equivalent semantics, so the user directory's
 *      permissions are the backstop there.
 *
 * Environment variables are always the last-resort fallback and are never written
 * to any storage.
 *
 * No tool ever returns the token — `accountView()` projects the internal record
 * into a "safe to display" summary.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The scope segment of a record in the store (a credentials key must be `<scope>/<id>`). */
const RECORD_SCOPE = 'github-repo'
const ACTIVE_ID = 'active'

/** An account id must match the syntax of a credentials key segment: a hyphenated identifier starting with a lowercase letter. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Environment variable name (POSIX identifier) syntax, used to validate tokenRef. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The default credentials reference name. */
export const DEFAULT_TOKEN_REF = 'GITHUB_TOKEN'

/** Turn a login name into a valid record id. */
export function accountIdFor(login) {
  const id = String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (id === '' || !ID_PATTERN.test(id)) {
    throw new Error(`Cannot derive a valid account id from login name "${login}" (only lowercase letters, digits and hyphens are allowed).`)
  }
  return id
}

/** record id → credentials key. */
function recordKeyFor(id) {
  return `${RECORD_SCOPE}/${id}`
}

/** Parse a credentials key of the form `<scope>/<id>`. */
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
 * Internal account record.
 * @typedef {object} AccountRecord
 * @property {string} id stable account id (= the normalized login name)
 * @property {string} login GitHub login name
 * @property {string} token PAT
 * @property {string} [name] display name (GitHub's name field)
 * @property {string} [scopes] token permission scopes (x-oauth-scopes response header)
 * @property {string} [source] where this account came from (for display)
 * @property {string} [boundAt] binding time (ISO string)
 */

/**
 * The model/user-facing account view: **without the token**.
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

/* ------------------------------------------------------------------ backend 1: DSH credentials service */

/**
 * Storage backed by `ctx.credentials`.
 *
 * It only uses members that actually exist on the service, and probes capabilities
 * at every step — the credentials service is not implemented consistently across
 * DSH versions/combinations, so a missing method should fall back cleanly instead
 * of throwing.
 * @param {any} provider
 */
export function createCredentialsStore(provider) {
  const can = name => provider && typeof provider[name] === 'function'
  if (!can('listRecords') || !can('readRecord')) return undefined

  /** Read one record and restore it into an AccountRecord. */
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
      if (!can('modifyRecord')) throw new Error('The credentials service does not support modifyRecord, so the current account cannot be recorded.')
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
        throw new Error('The credentials service does not support modifyRecord, so the account cannot be saved.')
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
      if (!can('deleteRecord')) throw new Error('The credentials service does not support deleteRecord, so the account cannot be deleted.')
      await provider.deleteRecord(recordKeyFor(id))
    },
  }
}

/* ------------------------------------------------------------------ backend 2: JSON file */

/**
 * The plugin's own JSON file storage.
 * @param {string} file
 */
export function createFileStore(file) {
  /** @type {{version: number, active?: string, accounts: AccountRecord[]} | undefined} */
  let cache

  const load = async () => {
    if (cache !== undefined) return cache
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      // No file yet: empty storage. Not an error.
      cache = { version: 1, accounts: [] }
      return cache
    }
    try {
      const parsed = JSON.parse(raw)
      cache = {
        version: 1,
        ...(typeof parsed?.active === 'string' ? { active: parsed.active } : {}),
        accounts: Array.isArray(parsed?.accounts) ? parsed.accounts.filter(isAccountRecord) : [],
      }
    } catch {
      // The file exists but does not parse. Keep it as an empty store so the plugin
      // stays usable, but move the unreadable file aside first: it holds bound
      // account tokens, and silently discarding it would destroy the only copy.
      await rename(file, `${file}.corrupt-${Date.now()}`)
        .then(() => undefined, () => undefined)
      cache = { version: 1, accounts: [] }
    }
    return cache
  }

  const persist = async state => {
    const directory = path.dirname(file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // The file holds account tokens, so keep both the file and its directory private
    // on POSIX. Windows has no equivalent semantic; the user profile's ACL is what
    // protects it there.
    await chmod(directory, 0o700).catch(() => {})
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

/* ------------------------------------------------------------------ backend selection */

/**
 * Select an available storage backend.
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
    reason: `file:${file} (the DSH credentials service is not mounted, so the plugin's own account file is used instead)`,
  }
}

/* ------------------------------------------------------------------ account management */

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
 * Build an account manager.
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
   * The currently effective account.
   *
   * Only **accounts that were actually bound** are ever returned here. A token from
   * an environment variable deliberately does not count as "bound": once the user
   * binds an account, that account should be used by default rather than being
   * shadowed by a GITHUB_TOKEN that happens to exist in the environment. Environment
   * variables only surface as a last-resort fallback when **no account at all is
   * bound**; in that case gh_account status marks the source as env:…, and the
   * onboarding text uses that to decide whether a binding prompt should be shown.
   *
   * @param {{allowEnvToken?: boolean}} [options] when allowEnvToken=false, ignore the environment-variable fallback
   */
  const activeRecord = async (options = {}) => {
    const id = await store.activeId()
    if (id !== undefined) {
      const record = (await store.list()).find(account => account.id === id)
      if (record !== undefined) return record
    }
    const all = await store.list()
    // No pointer but exactly one bound account → use it directly, so an explicit use is not needed every time.
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
        // The token in the environment variable is invalid: do not make the whole plugin
        // unusable, let the caller treat this as "not bound".
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

    /** Count only accounts that were **actually bound** (excluding the environment-variable fallback). */
    async boundCount() {
      return (await store.list()).length
    },

    async list() {
      const all = (await store.list()).map(account => ({ ...account }))
      const activeId = (await activeRecord())?.id
      return all.map(account => ({ ...account, __active: account.id === activeId }))
    },

    /**
     * Bind a token: confirm the identity with GitHub first, and only write to disk after that succeeds.
     * @param {string} token
     * @param {{source?: string}} [meta]
     */
    async bind(token, meta = {}) {
      const value = String(token ?? '').trim()
      if (value === '') throw new Error('The token must not be empty.')
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
     * Switch the current account.
     * @param {string} idOrLogin
     */
    async use(idOrLogin) {
      const record = await find(idOrLogin)
      if (record === undefined) {
        const all = await store.list()
        const known = all.map(account => account.login).join(', ')
        throw new Error(
          `Account "${idOrLogin}" not found. `
          + (known === '' ? 'No account is bound yet; bind one first with action=bind.' : `Bound accounts: ${known}.`),
        )
      }
      await store.setActive(record.id)
      return record
    },

    /**
     * Delete an account.
     * @param {string} idOrLogin
     */
    async remove(idOrLogin) {
      const record = await find(idOrLogin)
      if (record === undefined) throw new Error(`Account "${idOrLogin}" not found, nothing to delete.`)
      const wasActive = (await store.activeId()) === record.id
      await store.remove(record.id)
      return { id: record.id, wasActive }
    },
  }
}

/** Used by index.js to validate tokenRef. */
export function isValidTokenRef(value) {
  return REF_PATTERN.test(String(value ?? ''))
}

/** Display label for the current account (without the token). */
export function describeAccount(record) {
  if (record === undefined) return 'not bound'
  return `@${record.login}${record.source === undefined ? '' : ` (source: ${record.source})`}`
}
