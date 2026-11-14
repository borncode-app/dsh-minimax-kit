import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A sign-in problem the user can act on.
 *
 * Both plugins carry this shape; each passes its own class and code prefix so
 * `instanceof` and the reported code stay plugin-specific.
 */
export class AuthError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'AuthError'
    this.code = options.code ?? 'MINIMAX_AUTH_UNAVAILABLE'
  }
}

/** Wording shared by every plugin that borrows the MiniMax Code grant. */
export const AUTH_MESSAGES = {
  noSignIn: 'MiniMax Code is not signed in on this machine; open MiniMax Code and sign in.',
  corruptSignIn: 'The MiniMax Code sign-in file is unreadable; open MiniMax Code to repair it.',
  lockTimeout: 'The MiniMax sign-in refresh is busy; retry shortly.',
  expired: 'The MiniMax Code sign-in has expired; open MiniMax Code and sign in again.',
  invalidGrant: 'The MiniMax sign-in service returned an unusable grant.',
}

/** A finite non-negative number, or undefined. */
export function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Resolve a possibly wrapped configuration value. */
export function readConfig(config, field, fallback) {
  const value = config?.[field]
  if (value === undefined) return fallback
  const resolved = typeof value?.get === 'function' ? value.get() : value
  return resolved === undefined ? fallback : resolved
}

const sleep = (milliseconds) => new Promise(resolveSleep => { setTimeout(resolveSleep, milliseconds) })

/** The account origin that serves the OAuth token endpoint for a region. */
export function oauthAccountOrigin(region) {
  return region === 'cn' ? 'https://account.minimax.cn' : 'https://account.minimax.io'
}

/**
 * A cross-process lock compatible with MiniMax Code's own `auth.lock`.
 *
 * MiniMax Code locks the same file through `proper-lockfile`, which owns the
 * lock by atomically creating `<file>.lock` as a directory and treats a lock
 * idle past its stale window as abandoned. Creating and refreshing that same
 * directory keeps DSH's refresh and the app's refresh mutually exclusive.
 */
export async function withAuthLock(lockPath, operation, options = {}) {
  const directory = `${lockPath}.lock`
  const staleMs = options.staleMs ?? 30000
  const deadline = Date.now() + (options.timeoutMs ?? 20000)
  const fail = options.fail ?? ((code, message) => new AuthError(message, { code }))
  let acquired = false
  while (!acquired) {
    try {
      await mkdir(directory)
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let entry
      try {
        entry = await stat(directory)
      } catch {
        continue
      }
      if (Date.now() - entry.mtimeMs > staleMs) {
        await rmdir(directory).catch(() => {})
        continue
      }
      if (Date.now() > deadline) throw fail('LOCK_TIMEOUT', AUTH_MESSAGES.lockTimeout)
      await sleep(40 + Math.random() * 120)
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(directory, now, now).catch(() => {})
  }, Math.max(1000, Math.floor(staleMs / 3)))
  heartbeat.unref?.()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rmdir(directory).catch(() => {})
  }
}

/** Write a private file through a same-directory temporary name. */
export async function writePrivateFile(path, text) {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Read and refresh the MiniMax Code sign-in this account already stores.
 *
 * The plugin never signs in on its own: it borrows the OAuth grant MiniMax Code
 * wrote under `~/.minimax/auth`, refreshes it in place when it is about to
 * expire, and leaves error recovery (a rejected refresh token) to the app.
 *
 * Every plugin that borrows the grant must use this class rather than its own
 * copy: two implementations refreshing one grant can rotate each other's
 * refresh token out from under the other. The file lock narrows that window,
 * one implementation removes the divergence.
 */
export class MinimaxCodeAuth {
  /**
   * @param options.minimaxHome - MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax`.
   * @param options.buildEnv - OAuth build environment directory under the home.
   * @param options.region - OAuth region directory under the home.
   * @param options.tokenURL - OAuth token endpoint.
   * @param options.refreshSkewMs - Refresh this long before the token expires.
   * @param options.timeoutMs - One refresh request's deadline.
   * @param options.fetchImpl - The fetch implementation to use.
   * @param options.ErrorClass - Error class thrown for a problem the user can act on.
   * @param options.codePrefix - Code prefix, such as `MINIMAX_CREDIT_`.
   */
  constructor(options) {
    this.options = options
    this.cached = undefined
    this.lastError = undefined
    this.refreshing = undefined
  }

  /** An error carrying this plugin's class and code prefix. */
  fail(code, message) {
    const ErrorClass = this.options.ErrorClass ?? AuthError
    const fullCode = `${this.options.codePrefix ?? 'MINIMAX_AUTH_'}${code}`
    const error = new ErrorClass(message, { code: fullCode })
    // A caller's own class may not store `code`; the contract is that it does.
    if (error.code === undefined) error.code = fullCode
    return error
  }

  /** The directory holding the app's OAuth files. */
  paths() {
    const home = this.options.minimaxHome === undefined || this.options.minimaxHome.length === 0
      ? (process.env.MINIMAX_HOME ?? join(homedir(), '.minimax'))
      : this.options.minimaxHome
    const authHome = join(resolve(home), 'auth')
    const namespaceHome = join(authHome, this.options.buildEnv, this.options.region, 'mcode-public')
    const service = `com.minimax.mcode.oauth.${this.options.buildEnv}.${this.options.region}`
    const account = createHash('sha256').update(`${authHome}\0mcode-public`).digest('base64url')
    return {
      authHome,
      namespaceHome,
      credentialPath: join(namespaceHome, 'auth.json'),
      statePath: join(namespaceHome, 'auth-state.json'),
      lockPath: join(namespaceHome, 'auth.lock'),
      refreshPath: join(namespaceHome, 'refresh', 'auth.json'),
      recordKey: `${service}\0${account}`,
      service,
      account,
      buildEnv: this.options.buildEnv,
      region: this.options.region,
    }
  }

  /** The newest usable record in one credential payload. */
  recordOf(payload) {
    const records = payload?.records !== undefined && typeof payload.records === 'object' ? payload.records : {}
    const paths = this.paths()
    const exact = records[paths.recordKey]
    if (exact !== undefined) return { key: paths.recordKey, record: exact }
    for (const [key, record] of Object.entries(records)) {
      if (typeof record?.accessToken === 'string' && record.accessToken.length > 0) return { key, record }
    }
    return undefined
  }

  /** Read the app's credential store, or throw a sign-in guidance error. */
  async readCredential() {
    const paths = this.paths()
    let text
    try {
      text = await readFile(paths.credentialPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw this.fail('NO_SIGN_IN', AUTH_MESSAGES.noSignIn)
      throw error
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw this.fail('CORRUPT_SIGN_IN', AUTH_MESSAGES.corruptSignIn)
    }
    const found = this.recordOf(payload)
    if (found === undefined || typeof found.record.accessToken !== 'string') {
      throw this.fail('NO_SIGN_IN', AUTH_MESSAGES.noSignIn)
    }
    return { payload, ...found, paths }
  }

  /**
   * The current access token, refreshed when it is within the skew window.
   *
   * @param options.force - refresh even when the stored token still looks valid
   *   (used after the API answers 401 for it).
   */
  async token(options = {}) {
    const cached = this.cached
    if (cached !== undefined && options.force !== true && cached.expiresAtMs - Date.now() > this.options.refreshSkewMs) {
      return cached.accessToken
    }
    let current
    try {
      current = await this.readCredential()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
    if (expiresAtMs - Date.now() > this.options.refreshSkewMs && options.force !== true) {
      this.cached = { accessToken: current.record.accessToken, expiresAtMs }
      this.lastError = undefined
      return current.record.accessToken
    }
    return await this.refresh(current, options.force === true)
  }

  /** Refresh the grant once, under the shared auth lock. */
  async refresh(observed, force) {
    if (this.refreshing !== undefined) return this.refreshing
    const paths = this.paths()
    const run = async () => {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      if (force !== true && expiresAtMs - Date.now() > this.options.refreshSkewMs) {
        this.cached = { accessToken: current.record.accessToken, expiresAtMs }
        return current.record.accessToken
      }
      const grant = await this.requestRefresh(current.record.refreshToken)
      const generation = Math.max(numberOf(current.record.generation) ?? 0, await this.stateGeneration()) + 1
      const record = {
        ...current.record,
        schemaVersion: 1,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        tokenType: 'Bearer',
        clientId: 'mcode-public',
        scopes: grant.scopes,
        audience: 'agent-backend',
        expiresAtMs: grant.expiresAtMs,
        generation,
        loginEpoch: current.record.loginEpoch ?? randomUUID(),
      }
      const payload = {
        schemaVersion: 1,
        records: { ...(current.payload.records ?? {}), [current.key]: record },
      }
      await writePrivateFile(paths.credentialPath, `${JSON.stringify(payload, null, 2)}\n`)
      const state = {
        schemaVersion: 2,
        status: 'authenticated',
        storeKind: 'file',
        clientId: 'mcode-public',
        scopes: grant.scopes,
        audience: 'agent-backend',
        buildEnv: paths.buildEnv,
        region: paths.region,
        generation,
        expiresAtMs: grant.expiresAtMs,
      }
      await writePrivateFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`)
      await unlink(paths.refreshPath).catch(() => {})
      this.cached = { accessToken: grant.accessToken, expiresAtMs: grant.expiresAtMs }
      this.lastError = undefined
      return grant.accessToken
    }
    this.refreshing = withAuthLock(paths.lockPath, run, { fail: (code, message) => this.fail(code, message) })
    try {
      return await this.refreshing
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.refreshing = undefined
    }
  }

  /** The generation of the last committed auth state, when present. */
  async stateGeneration() {
    try {
      const state = JSON.parse(await readFile(this.paths().statePath, 'utf8'))
      return numberOf(state?.generation) ?? 0
    } catch {
      return 0
    }
  }

  /** Trade the refresh token for a new grant. */
  async requestRefresh(refreshToken) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'mcode-public',
      scope: 'agent.default',
      audience: 'agent-backend',
    })
    let response
    try {
      response = await this.options.fetchImpl(this.options.tokenURL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      })
    } catch (error) {
      throw this.fail('REFRESH_NETWORK', `The MiniMax sign-in could not be refreshed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw this.fail('REFRESH_HTTP', `The MiniMax sign-in service answered HTTP ${String(response.status)}.`)
    }
    const errorCode = typeof body?.error === 'string' ? body.error : undefined
    if (!response.ok || errorCode !== undefined) {
      if (errorCode === 'invalid_grant' || response.status === 400) {
        throw this.fail('SIGN_IN_EXPIRED', AUTH_MESSAGES.expired)
      }
      throw this.fail('REFRESH_HTTP', `The MiniMax sign-in service answered HTTP ${String(response.status)}${errorCode === undefined ? '' : ` (${errorCode})`}.`)
    }
    const accessToken = typeof body?.access_token === 'string' ? body.access_token : undefined
    const nextRefresh = typeof body?.refresh_token === 'string' ? body.refresh_token : undefined
    const expiresIn = numberOf(body?.expires_in)
    const tokenType = typeof body?.token_type === 'string' ? body.token_type : 'Bearer'
    if (accessToken === undefined || nextRefresh === undefined || expiresIn === undefined || expiresIn <= 0 || tokenType.toLowerCase() !== 'bearer') {
      throw this.fail('REFRESH_INVALID', AUTH_MESSAGES.invalidGrant)
    }
    const scopes = typeof body?.scope === 'string' && body.scope.trim().length > 0
      ? body.scope.trim().split(/\s+/u)
      : ['agent.default']
    return { accessToken, refreshToken: nextRefresh, expiresAtMs: Date.now() + expiresIn * 1000, scopes }
  }

  /** The current access token without refreshing it; undefined when expired. */
  async peekToken() {
    try {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      return expiresAtMs > Date.now() ? current.record.accessToken : undefined
    } catch {
      return undefined
    }
  }

  /** A status reading that never refreshes and never throws. */
  async status() {
    try {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      return {
        ok: true,
        source: 'miniMaxCode',
        expiresInMs: Math.max(0, expiresAtMs - Date.now()),
        needsRefresh: expiresAtMs - Date.now() <= this.options.refreshSkewMs,
        refreshing: this.refreshing !== undefined,
      }
    } catch (error) {
      return {
        ok: false,
        source: 'miniMaxCode',
        reason: error instanceof Error ? error.message : String(error),
        code: error?.code ?? `${this.options.codePrefix ?? 'MINIMAX_AUTH_'}UNAVAILABLE`,
      }
    }
  }
}
