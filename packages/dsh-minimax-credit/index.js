import z from '@deepseek-ai/schemastery'
import { MinimaxCodeAuth, numberOf, oauthAccountOrigin, readConfig } from '@local/dsh-minimax-auth'
import { ofmAccessToken } from '@local/dsh-minimax-auth/ofm-auth'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

/**
 * Services this plugin waits for before it applies.
 *
 * The status route is served by the Web GUI's own server, so the plugin must
 * not apply before that service exists: without this declaration the route
 * was registered against a server that was not there yet, the Web GUI answered
 * 404 for `/plugins/minimax-credit/status`, and the credits chip never
 * rendered.
 */
export const inject = ['webServer']

/** Anthropic Messages compatibility paths this proxy serves. */
const MESSAGES_PATH = '/v1/messages'
const MODELS_PATH = '/v1/models'

/**
 * Response wording that marks the Token Plan limit rather than a transient
 * rate limit. MiniMax Code's own error for this is "Token Plan usage limit
 * reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)".
 */
export const QUOTA_PATTERN = /token plan usage limit|usage limit reached|purchase credits|insufficient credits|\(2056\)/iu

/** Headers that describe one hop, never the request. */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection',
])

/** A missing or unusable MiniMax Code sign-in, with user-facing guidance. */
export class CreditUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'CreditUnavailableError'
    this.code = options.code ?? 'MINIMAX_CREDIT_UNAVAILABLE'
  }
}

export const Config = z.object({
  /** When the plan quota is spent, continue on MiniMax credits. */
  enabled: z.boolean().default(true),
  /** Loopback address the local proxy binds. */
  listenHost: z.string().default('127.0.0.1'),
  /** Port the local proxy binds; the route's baseURL must use the same port. */
  listenPort: z.number().default(45677),
  /** MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax`. */
  minimaxHome: z.string().default(''),
  /** OAuth build environment directory under the MiniMax home. */
  buildEnv: z.string().default('prod'),
  /** OAuth region directory under the MiniMax home. */
  region: z.string().default('en'),
  /** OAuth token endpoint; empty derives it from buildEnv and region. */
  oauthTokenURL: z.string().default(''),
  /** Token Plan endpoint the route normally speaks to. */
  planBaseURL: z.string().default('https://api.minimax.io/anthropic'),
  /** MiniMax Code credit endpoint (the mavis LLM proxy). */
  creditBaseURL: z.string().default('https://agent.minimax.io/mavis/api/v1/llm/v1'),
  /** Coding-plan quota reading endpoint used to decide before dispatching. */
  quotaURL: z.string().default('https://api.minimax.io/v1/api/openplatform/coding_plan/remains'),
  /** Account endpoint reporting the Token Plan credit pool and fallback switch. */
  creditURL: z.string().default('https://api.minimax.io/backend/account/token_plan_credit'),
  /** Account endpoint reporting the membership and open-platform credit summary. */
  membershipURL: z.string().default('https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info'),
  /** Account endpoint reporting the platform wallet balance. */
  walletURL: z.string().default('https://api.minimax.io/account/query_balance'),
  /** Milliseconds a credit reading is reused before another probe. */
  creditsCacheMs: z.number().default(60000),
  /** Credential reference that resolves the plan API key. */
  apiKeyEnv: z.string().default('MINIMAX_API_KEY'),
  /**
   * Look for the MiniMax Code grant Our Free Model stores before the API key.
   *
   * Our Free Model runs a MiniMax Code channel of its own and keeps a signed-in
   * grant for it. When that channel is the account in use, its grant is the one
   * that answers the quota and credit endpoints, so it is read first.
   */
  preferOfmGrant: z.boolean().default(true),
  /** Our Free Model home; empty means `$DSH_HOME` or `~/.dsh`. */
  ofmHome: z.string().default(''),
  /** The Our Free Model account key that holds the MiniMax Code grant. */
  ofmAccount: z.string().default('minimax-code-global'),
  /** Milliseconds a quota reading is reused before another probe. */
  quotaCacheMs: z.number().default(60000),
  /** Refresh the OAuth token this long before it expires. */
  refreshSkewMs: z.number().default(600000),
  /** Same-origin Web GUI path that reports the proxy state. */
  statusPath: z.string().default('/plugins/minimax-credit/status'),
})

/** Whole seconds as a short "3h 12m" reading. */
function duration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
  const totalMinutes = Math.floor(milliseconds / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  return `${String(minutes)}m`
}

/** Trim a trailing slash so base URLs concatenate cleanly. */
const withoutSlash = (value) => value.replace(/\/+$/u, '')

/** The OAuth token endpoint for a build environment and region. */
export function oauthTokenURLFor(buildEnv, region) {
  return `${oauthAccountOrigin(region)}/oauth2/token`
}

/**
 * This plugin's view of the shared MiniMax Code grant.
 *
 * The grant reader and refresher live in `@local/dsh-minimax-auth`, so this
 * plugin and the daily check-in cannot rotate each other's refresh token. Only
 * the error class and code prefix are local: the proxy answers 503 and
 * `authentication_error` for `instanceof CreditUnavailableError`.
 */
export class TokenSource extends MinimaxCodeAuth {
  constructor(options) {
    super({ ...options, ErrorClass: CreditUnavailableError, codePrefix: 'MINIMAX_CREDIT_' })
  }

  /**
   * The access token the credit route carries.
   *
   * The grant Our Free Model stores comes first: that plugin drives a MiniMax
   * Code channel of its own, and the grant it keeps is the account the credit
   * route bills. It is read as it stands and never refreshed here — Our Free
   * Model owns that cycle for its own channel, and a second refresher would
   * rotate the refresh token out from under it.
   *
   * The MiniMax Code desktop grant is the fallback, and the only one this
   * plugin refreshes.
   */
  async token(options = {}) {
    if (this.options.preferOfmGrant === true) {
      const grant = await ofmAccessToken({ ofmHome: this.options.ofmHome, ofmAccount: this.options.ofmAccount })
      if (grant !== undefined) return grant
    }
    return await super.token(options)
  }
}

/**
 * The coding-plan quota, probed at most once per cache window.
 *
 * The probe is advisory: a dispatch still verifies the plan endpoint's answer,
 * so a stale reading can never turn a live plan request into a credit charge.
 */
export class PlanQuota {
  constructor(options) {
    this.options = options
    this.cached = undefined
    this.cacheKey = undefined
  }

  /** The last reading this process recorded. */
  peek() {
    return this.cached
  }

  /** Record the plan endpoint's own quota refusal. */
  markExhausted() {
    const previous = this.cached ?? {}
    this.cached = {
      ...previous,
      exhausted: true,
      percent: 0,
      at: new Date().toISOString(),
      source: 'plan-error',
    }
  }

  /** Probe the quota endpoint for one API key, reusing a fresh reading. */
  async check(apiKey) {
    if (typeof apiKey !== 'string' || apiKey.length === 0) return this.cached
    const key = createHash('sha256').update(apiKey).digest('base64url')
    if (this.cached !== undefined && this.cacheKey === key && Date.now() - Date.parse(this.cached.at) < this.options.cacheMs) return this.cached
    let response
    try {
      response = await this.options.fetchImpl(this.options.url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
      })
    } catch {
      return this.cached
    }
    if (!response.ok) {
      await response.body?.cancel()
      return this.cached
    }
    let body
    try {
      body = await response.json()
    } catch {
      return this.cached
    }
    const rows = Array.isArray(body?.model_remains) ? body.model_remains : []
    const row = rows.find(entry => entry?.model_name === 'general') ?? rows[0]
    if (row === undefined) return this.cached
    const percent = numberOf(row.current_interval_remaining_percent)
    const weeklyPercent = numberOf(row.current_weekly_remaining_percent)
    const exhausted = (percent !== undefined && percent <= 0) || (weeklyPercent !== undefined && weeklyPercent <= 0)
    this.cacheKey = key
    this.cached = {
      exhausted,
      percent,
      weeklyPercent,
      resetInMs: numberOf(row.remains_time),
      weeklyResetInMs: numberOf(row.weekly_remains_time),
      at: new Date().toISOString(),
      source: 'quota-probe',
    }
    return this.cached
  }
}

/**
 * Drop thinking controls the credit route refuses.
 *
 * MiniMax's credit route always reasons: a body carrying
 * `thinking: {type:'disabled'}` is rejected with `requires adaptive thinking`,
 * so a retry sends the same request without that switch (and without an effort
 * of `none`/`off`, which expresses the same thing).
 */
export function withoutDisabledThinking(raw) {
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return raw
  }
  if (typeof body !== 'object' || body === null) return raw
  let changed = false
  if (body.thinking !== undefined && typeof body.thinking === 'object' && body.thinking.type === 'disabled') {
    delete body.thinking
    changed = true
  }
  const relax = (message) => {
    const config = message?.output_config
    if (config === undefined || typeof config !== 'object') return
    if (config.effort === 'none' || config.effort === 'off') {
      delete message.output_config
      changed = true
    }
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) relax(message)
  relax(body)
  return changed ? Buffer.from(JSON.stringify(body)) : raw
}

/**
 * The account's MiniMax credits and wallet balance.
 *
 * MiniMax Code's OAuth token can read the same numbers its Usage page shows:
 * the open-platform credit summary (`op_credit_summary`, which is what its
 * "Credits" row renders), the Token Plan credit pool plus fallback switch, and
 * the platform wallet. Reading is advisory only; the credit endpoint stays the
 * authority on what a request is charged.
 */
export class CreditBalance {
  constructor(options) {
    this.options = options
    this.cached = undefined
    this.inflight = undefined
  }

  /** The last reading this process recorded. */
  peek() {
    return this.cached
  }

  /** Read the account endpoints, reusing a fresh reading. */
  async read(token) {
    if (typeof token !== 'string' || token.length === 0) return this.cached
    if (this.cached !== undefined && Date.now() - Date.parse(this.cached.at) < this.options.cacheMs) return this.cached
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.refresh(token)
    try {
      return await this.inflight
    } catch {
      return this.cached
    } finally {
      this.inflight = undefined
    }
  }

  /** Fetch the membership summary, credit pool, and wallet in one pass. */
  async refresh(token) {
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` }
    const [membership, credit, wallet] = await Promise.all([
      this.requestJSON('POST', this.options.membershipURL, { ...headers, 'content-type': 'application/json' }, '{}'),
      this.requestJSON('GET', this.options.creditURL, headers),
      this.requestJSON('GET', this.options.walletURL, headers),
    ])
    const info = membership.body ?? {}
    const summary = info.op_credit_summary ?? {}
    const totalRemaining = money(summary.total_remaining_amount)
    const remaining = totalRemaining ?? money(info.opcredit_balance ?? info.total_remains_credit)
    const walletBody = wallet.body ?? {}
    const credits = credit.body ?? {}
    const expiresAtMs = numberOf(info.token_plan_expires_at)
    this.cached = {
      ok: membership.body !== undefined && remaining !== undefined,
      remaining: remaining === undefined ? undefined : Math.floor(remaining),
      remainingExact: remaining,
      purchasedRemaining: money(summary.purchased_remaining_amount ?? summary.purchased_credit),
      freeRemaining: money(summary.free_remaining_amount ?? summary.free_credit),
      plan: membership.body === undefined ? undefined : {
        hasTokenPlan: info.has_token_plan === true,
        tier: typeof info.token_plan_tier === 'string' ? info.token_plan_tier : undefined,
        expiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
      },
      fallbackEnabled: typeof credits.token_plan_credit_fallback_enabled === 'boolean' ? credits.token_plan_credit_fallback_enabled : undefined,
      creditFirstForHighCost: typeof credits.enable_credit_first_for_high_cost === 'boolean' ? credits.enable_credit_first_for_high_cost : undefined,
      tokenPlanCredit: credit.body === undefined ? undefined : {
        remaining: numberOf(credits.remaining_credits),
        total: numberOf(credits.total_credits),
        used: numberOf(credits.used_credits),
      },
      wallet: wallet.body === undefined ? undefined : {
        available: money(walletBody.available_amount),
        cash: money(walletBody.cash_balance),
        voucher: money(walletBody.voucher_balance),
        credit: money(walletBody.credit_balance),
        owed: money(walletBody.owed_amount),
      },
      failure: membership.failure ?? credit.failure ?? wallet.failure,
      at: new Date().toISOString(),
    }
    return this.cached
  }

  /** One authenticated request returning parsed JSON, or a refusal describing why. */
  async requestJSON(method, url, headers, body) {
    let response
    try {
      response = await this.options.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
      })
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { failure: `HTTP ${String(response.status)}` }
    }
    try {
      return { body: await response.json() }
    } catch {
      return { failure: 'the reply was not JSON' }
    }
  }
}

/** A decimal from a string amount, or undefined. */
function money(value) {
  if (value === undefined || value === null) return undefined
  const amount = Number.parseFloat(String(value))
  return Number.isFinite(amount) ? amount : undefined
}

/** Read one request body as bytes, refusing oversized payloads. */
async function readBody(req, maximum = 96 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maximum) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Answer with JSON. */
function sendJSON(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

/** Copy the upstream reply to the client without buffering its body. */
async function relay(res, upstream) {
  const headers = {}
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'content-length' || name === 'set-cookie') continue
    headers[name] = value
  }
  res.writeHead(upstream.status, headers)
  res.flushHeaders?.()
  if (upstream.body === null) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise(resolveDrain => { res.once('drain', resolveDrain) })
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    if (!res.writableEnded) res.end()
  }
}

/** Copy an upstream reply whose body was already read, status and all. */
async function sendBuffered(res, upstream, text) {
  const body = text ?? await upstream.text().catch(() => '')
  const headers = {}
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'content-length' || name === 'set-cookie') continue
    headers[name] = value
  }
  res.writeHead(upstream.status, headers)
  res.end(body)
}

/**
 * A local Anthropic-Messages proxy in front of one MiniMax route.
 *
 * Requests reach the Token Plan endpoint while the plan has quota. Once the
 * plan reports its limit, the same request is sent to the MiniMax Code credit
 * endpoint with the app's OAuth token, so a conversation continues on credits
 * exactly as it does inside MiniMax Code.
 */
export class MinimaxCreditProxy {
  constructor(options) {
    this.options = options
    this.tokens = options.tokens
    this.quota = options.quota
    this.credits = options.credits
    this.fetchImpl = options.fetchImpl
    this.logger = options.logger
    this.stats = { planned: 0, credited: 0, fallbacks: 0, errors: 0, refused: 0 }
    this.lastError = undefined
    this.server = undefined
    this.url = undefined
  }

  /** Bind the proxy port. */
  async listen() {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      this.logger?.warn?.(`minimax-credit: client error: ${error.message}`)
    })
    await new Promise((resolveListen, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.listenPort, this.options.listenHost, () => {
        this.server.off('error', reject)
        this.server.on('error', error => {
          this.logger?.warn?.(`minimax-credit: ${error instanceof Error ? error.message : String(error)}`)
        })
        resolveListen()
      })
    })
    const address = this.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.options.listenPort
    this.url = `http://${this.options.listenHost}:${String(port)}`
    return this.url
  }

  /** Stop accepting requests and drop idle connections. */
  async close() {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    await new Promise(resolveClose => {
      server.close(() => { resolveClose() })
      server.closeIdleConnections?.()
    })
  }

  /** A JSON snapshot for the Web GUI and for troubleshooting. */
  async status() {
    const quota = this.quota.peek()
    // A cached reading reports the reset as of the probe; count down from now.
    const age = quota?.at === undefined ? 0 : Math.max(0, Date.now() - Date.parse(quota.at))
    const resetInMs = quota?.resetInMs === undefined ? undefined : Math.max(0, quota.resetInMs - age)
    const weeklyResetInMs = quota?.weeklyResetInMs === undefined ? undefined : Math.max(0, quota.weeklyResetInMs - age)
    let credits = this.credits?.peek?.()
    if (this.credits !== undefined) {
      const token = await this.tokens.peekToken?.()
      if (token !== undefined) credits = await this.credits.read(token)
    }
    return {
      ok: true,
      enabled: this.options.enabled,
      proxy: this.url,
      route: {
        plan: withoutSlash(this.options.planBaseURL),
        credit: withoutSlash(this.options.creditBaseURL),
      },
      mode: this.options.enabled !== true
        ? 'plan-only'
        : quota?.exhausted === true ? 'credits' : quota === undefined ? 'unknown' : 'plan',
      plan: quota === undefined ? null : {
        exhausted: quota.exhausted === true,
        percent: quota.percent,
        weeklyPercent: quota.weeklyPercent,
        resetInMs,
        resetIn: duration(resetInMs),
        weeklyResetIn: duration(weeklyResetInMs),
        checkedAt: quota.at,
        source: quota.source,
      },
      token: await this.tokens.status(),
      credits: credits ?? null,
      stats: { ...this.stats },
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  /** Route one HTTP request. */
  async handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname.replace(/\/+$/u, '') || '/'
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/status')) {
        sendJSON(res, 200, await this.status(), { 'access-control-allow-origin': '*' })
        return
      }
      const stripped = pathname.startsWith('/anthropic') ? pathname.slice('/anthropic'.length) || '/' : pathname
      // Accept both the Anthropic root spelling (`/v1/messages`) and a base that
      // already names the version (`…/v1` + `/messages`).
      const route = stripped === '/messages' ? MESSAGES_PATH : stripped === '/models' ? MODELS_PATH : stripped
      if (req.method === 'POST' && route === MESSAGES_PATH) {
        await this.messages(req, res)
        return
      }
      if (req.method === 'GET' && route === MODELS_PATH) {
        await this.models(req, res)
        return
      }
      sendJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Unknown path ${pathname}` } })
    } catch (error) {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`minimax-credit: ${this.lastError}`)
      if (!res.headersSent) sendJSON(res, 500, { type: 'error', error: { type: 'api_error', message: this.lastError } })
      else if (!res.writableEnded) res.end()
    }
  }

  /** The plan API key a request carries, or the configured credential. */
  async apiKeyOf(incoming) {
    const header = incoming['x-api-key']
    if (typeof header === 'string' && header.length > 0) return header
    return await this.options.resolveApiKey?.()
  }

  /** One inference call, planned first and credited when the plan is spent. */
  async messages(req, res) {
    const raw = await readBody(req)
    try {
      JSON.parse(raw.toString('utf8'))
    } catch {
      sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'The request body is not JSON.' } })
      return
    }
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', abort)
    try {
      const incoming = req.headers
      const apiKey = await this.apiKeyOf(incoming)
      let creditFirst = false
      if (this.options.enabled === true) {
        const quota = await this.quota.check(apiKey)
        creditFirst = quota?.exhausted === true
      }
      if (!creditFirst) {
        const plan = await this.dispatch('plan', raw, incoming, { apiKey, signal: controller.signal })
        if (plan.ok) {
          this.stats.planned += 1
          await relay(res, plan.response)
          return
        }
        const refusal = await this.refusalOf(plan.response)
        if (this.options.enabled !== true || !refusal.quota) {
          this.stats.refused += 1
          this.stats.planned += 1
          await sendBuffered(res, plan.response, refusal.text)
          return
        }
        this.quota.markExhausted()
        this.stats.fallbacks += 1
      }
      await this.dispatchCredits(res, raw, incoming, controller.signal)
    } catch (error) {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`minimax-credit: ${this.lastError}`)
      try {
        if (!res.headersSent) sendJSON(res, error instanceof CreditUnavailableError ? 503 : 502, {
          type: 'error',
          error: {
            type: error instanceof CreditUnavailableError ? 'authentication_error' : 'api_error',
            message: this.lastError,
          },
        })
        else if (!res.writableEnded) res.end()
      } catch {
        /* the client may already be gone */
      }
    } finally {
      res.off('close', abort)
    }
  }

  /** Keep the plan route's model listing working through the proxy. */
  async models(req, res) {
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', abort)
    try {
      const headers = this.forwardHeaders(req.headers, { mode: 'plan', apiKey: await this.apiKeyOf(req.headers) })
      const target = `${withoutSlash(this.options.planBaseURL)}${MODELS_PATH}?limit=1000`
      const upstream = await this.fetchImpl(target, { method: 'GET', headers, signal: controller.signal })
      await relay(res, upstream)
    } catch (error) {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: this.lastError } })
      else if (!res.writableEnded) res.end()
    } finally {
      res.off('close', abort)
    }
  }

  /** Send one request to a named route. */
  async dispatch(mode, body, incoming, options = {}) {
    // The plan base is the Anthropic root (`…/anthropic`), while the credit
    // base already names the Messages API (`…/llm/v1`).
    const url = mode === 'plan'
      ? `${withoutSlash(this.options.planBaseURL)}${MESSAGES_PATH}`
      : `${withoutSlash(this.options.creditBaseURL)}/messages`
    const headers = this.forwardHeaders(incoming, { mode, apiKey: options.apiKey, token: options.token })
    const response = await this.fetchImpl(url, { method: 'POST', headers, body, signal: options.signal })
    return { ok: response.ok, response }
  }

  /**
   * Send the request to the credit endpoint.
   *
   * The credit route refuses a "disabled thinking" request because those models
   * always reason, so a 400 that names that rule is retried once without the
   * thinking controls. A 401 is retried once with the same token (MiniMax Code
   * answers a transient 401 under bursts), and only a second 401 forces a
   * refresh, so a normal token is never rotated needlessly.
   */
  async dispatchCredits(res, body, incoming, signal) {
    let token = await this.tokens.token()
    let upstream = await this.dispatch('credit', body, incoming, { token, signal })
    if (upstream.response.status === 401) {
      await upstream.response.body?.cancel()
      upstream = await this.dispatch('credit', body, incoming, { token, signal })
    }
    if (upstream.response.status === 401) {
      await upstream.response.body?.cancel()
      token = await this.tokens.token({ force: true })
      upstream = await this.dispatch('credit', body, incoming, { token, signal })
    }
    if (upstream.response.status === 400) {
      const text = await upstream.response.clone().text().catch(() => '')
      if (/requires adaptive thinking/iu.test(text)) {
        const relaxed = withoutDisabledThinking(body)
        if (relaxed !== body) {
          await upstream.response.body?.cancel()
          upstream = await this.dispatch('credit', relaxed, incoming, { token, signal })
        }
      }
    }
    if (upstream.ok) this.stats.credited += 1
    else this.stats.refused += 1
    await relay(res, upstream.response)
  }

  /**
   * Read a plan refusal once and decide whether it means the plan is spent.
   *
   * The body is consumed here, so the caller forwards it with `sendBuffered`
   * instead of relaying it a second time.
   */
  async refusalOf(response) {
    if (response.status !== 429 && response.status !== 403) return { quota: false, text: undefined }
    let text = ''
    try { text = await response.text() } catch { text = '' }
    return { quota: QUOTA_PATTERN.test(text), text }
  }

  /**
   * Build the upstream headers for one route.
   *
   * The plan route forwards the caller's key. The credit route replaces both
   * auth headers with the MiniMax Code OAuth bearer and a placeholder key,
   * because the credit endpoint only accepts the bearer.
   */
  forwardHeaders(incoming, { mode, apiKey, token }) {
    const headers = {}
    for (const [name, value] of Object.entries(incoming)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === 'accept-encoding' || name === 'cookie') continue
      headers[name] = value
    }
    headers['accept-encoding'] = 'identity'
    if (mode === 'plan') {
      if (headers['x-api-key'] === undefined && typeof apiKey === 'string' && apiKey.length > 0) headers['x-api-key'] = apiKey
      return headers
    }
    delete headers['x-api-key']
    delete headers.authorization
    headers['x-api-key'] = 'sk-minimax-credit'
    headers.authorization = `Bearer ${token}`
    if (headers['anthropic-version'] === undefined) headers['anthropic-version'] = '2023-06-01'
    if (headers.accept === undefined) headers.accept = 'application/json'
    return headers
  }
}

/**
 * Mount the proxy and its status route.
 *
 * The inference proxy binds its own loopback port because an llm-pi-ai route's
 * `baseURL` is a literal origin that must not change when the Web GUI port
 * changes. The status reading is registered on the Web server instead, so the
 * Web GUI can poll it on its own origin.
 */
export function apply(ctx, config) {
  const settings = {
    enabled: readConfig(config, 'enabled', true),
    listenHost: readConfig(config, 'listenHost', '127.0.0.1'),
    listenPort: readConfig(config, 'listenPort', 45677),
    minimaxHome: readConfig(config, 'minimaxHome', ''),
    buildEnv: readConfig(config, 'buildEnv', 'prod'),
    region: readConfig(config, 'region', 'en'),
    planBaseURL: readConfig(config, 'planBaseURL', 'https://api.minimax.io/anthropic'),
    creditBaseURL: readConfig(config, 'creditBaseURL', 'https://agent.minimax.io/mavis/api/v1/llm/v1'),
    quotaURL: readConfig(config, 'quotaURL', 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains'),
    creditURL: readConfig(config, 'creditURL', 'https://api.minimax.io/backend/account/token_plan_credit'),
    membershipURL: readConfig(config, 'membershipURL', 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info'),
    walletURL: readConfig(config, 'walletURL', 'https://api.minimax.io/account/query_balance'),
    apiKeyEnv: readConfig(config, 'apiKeyEnv', 'MINIMAX_API_KEY'),
    preferOfmGrant: readConfig(config, 'preferOfmGrant', true),
    ofmHome: readConfig(config, 'ofmHome', ''),
    ofmAccount: readConfig(config, 'ofmAccount', 'minimax-code-global'),
    quotaCacheMs: readConfig(config, 'quotaCacheMs', 60000),
    creditsCacheMs: readConfig(config, 'creditsCacheMs', 60000),
    refreshSkewMs: readConfig(config, 'refreshSkewMs', 600000),
    statusPath: readConfig(config, 'statusPath', '/plugins/minimax-credit/status'),
  }
  const oauthTokenURL = readConfig(config, 'oauthTokenURL', '') || oauthTokenURLFor(settings.buildEnv, settings.region)
  const logger = ctx.logger
  const tokens = new TokenSource({
    minimaxHome: settings.minimaxHome,
    buildEnv: settings.buildEnv,
    region: settings.region,
    tokenURL: oauthTokenURL,
    refreshSkewMs: settings.refreshSkewMs,
    fetchImpl: fetch,
    preferOfmGrant: settings.preferOfmGrant,
    ofmHome: settings.ofmHome,
    ofmAccount: settings.ofmAccount,
  })
  const quota = new PlanQuota({ url: settings.quotaURL, cacheMs: settings.quotaCacheMs, fetchImpl: fetch })
  const credits = new CreditBalance({
    creditURL: settings.creditURL,
    membershipURL: settings.membershipURL,
    walletURL: settings.walletURL,
    cacheMs: settings.creditsCacheMs,
    fetchImpl: fetch,
  })
  const proxy = new MinimaxCreditProxy({
    enabled: settings.enabled,
    listenHost: settings.listenHost,
    listenPort: settings.listenPort,
    planBaseURL: settings.planBaseURL,
    creditBaseURL: settings.creditBaseURL,
    statusPath: settings.statusPath,
    fetchImpl: fetch,
    tokens,
    quota,
    credits,
    logger,
    resolveApiKey: async () => {
      // The Our Free Model grant comes first: when that plugin drives the
      // MiniMax Code channel, its grant is the account the quota and credit
      // endpoints answer for. The API key is the fallback for a plain
      // Token Plan account.
      if (settings.preferOfmGrant === true) {
        const grant = await ofmAccessToken({ ofmHome: settings.ofmHome, ofmAccount: settings.ofmAccount })
        if (grant !== undefined) return grant
      }
      try {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return undefined
        const hit = await credentials.resolve(settings.apiKeyEnv)
        return hit?.value
      } catch {
        return undefined
      }
    },
  })

  ctx.effect(() => {
    let closed = false
    // Warm the quota reading so the status route (and the composer badge) knows
    // which route is in use before the first inference request arrives.
    void (async () => {
      try {
        const key = await proxy.options.resolveApiKey?.()
        if (key !== undefined) await quota.check(key)
      } catch {
        /* a probe that cannot answer leaves the mode unknown */
      }
    })()
    void proxy.listen().then(url => {
      if (closed) return
      logger?.info?.(`minimax-credit: proxy listening at ${url}; set the minimax-api route baseURL to ${url}/anthropic`)
    }).catch(error => {
      logger?.warn?.(`minimax-credit: proxy could not listen on ${settings.listenHost}:${String(settings.listenPort)}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      closed = true
      void proxy.close()
    }
  }, 'minimax-credit: inference proxy')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: settings.statusPath,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        void proxy.status().then(body => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }).catch(error => {
          res.writeHead(500)
          res.end(String(error instanceof Error ? error.message : error))
        })
      },
    })
    return dispose
  }, 'minimax-credit: status route')
}
