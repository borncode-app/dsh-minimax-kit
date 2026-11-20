import z from '@deepseek-ai/schemastery'
import { MinimaxCodeAuth, numberOf, oauthAccountOrigin, readConfig } from '@local/dsh-minimax-auth'
import { ofmAccessToken } from '@local/dsh-minimax-auth/ofm-auth'

/**
 * A MiniMax-backed web search provider.
 *
 * MiniMax serves the Anthropic-compatible Messages endpoint with a native
 * `web_search_20250305` server tool: the model runs the search on MiniMax's
 * servers and the answer comes back in one request, with no auxiliary model
 * turn on the DeepSeek side. The provider therefore speaks the same wire
 * format as the DeepSeek search provider and reuses its result shape.
 *
 * The provider never reaches for DeepSeek. It reads the MiniMax Token Plan
 * key, and — like the credit proxy beside it — falls over to the MiniMax Code
 * credit grant when the plan's quota is spent, so a search keeps working after
 * the plan window closes.
 */

/** Stable id this provider registers under in the search registry. */
export const MINIMAX_SEARCH_PROVIDER_ID = 'minimax-web-search'

/** Default Anthropic-compatible base; `/v1/messages` is appended. */
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic'

/** Default model that answers the search. */
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3.1-Flash'

/** Default `anthropic-version` header value. */
export const MINIMAX_DEFAULT_API_VERSION = '2023-06-01'

/** Default upper bound on generated tokens for one search request. */
export const MINIMAX_DEFAULT_MAX_TOKENS = 4096

/**
 * Default number of `web_search` server-tool uses per request.
 *
 * MiniMax ends a turn with `pause_turn` when it reaches the tool's limit, so
 * a low value costs an extra round trip. One use already returns about ten
 * results, which covers the ten sources the seam hands the model.
 */
export const MINIMAX_DEFAULT_MAX_USES = 3

/** Maximum number of continuation rounds after a `pause_turn`. */
export const MINIMAX_DEFAULT_MAX_CONTINUATIONS = 4

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-minimax-web-search/1.0.0'

/**
 * The response wording that marks the Token Plan limit rather than a
 * transient rate limit. MiniMax Code's own error for this is "Token Plan
 * usage limit reached: Upgrade your Token Plan or purchase Credits for more
 * usage. (2056)".
 */
export const QUOTA_PATTERN = /token plan usage limit|usage limit reached|purchase credits|insufficient credits|\(2056\)/iu

/** A search failure the user can act on. */
export class MinimaxSearchError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'MinimaxSearchError'
    this.code = options.code ?? 'MINIMAX_SEARCH_FAILED'
  }
}

/**
 * The web seam this provider registers into.
 *
 * `credentials` is optional, so it is not injected: the provider reads it
 * when the profile mounts one and falls back to the MiniMax Code grant when
 * the profile has none.
 */
export const inject = ['web']

export const Config = z.object({
  /** Anthropic-compatible endpoint base; `/v1/messages` is appended. */
  baseURL: z.string().default(MINIMAX_DEFAULT_BASE_URL),
  /** Model that answers the search. */
  model: z.string().default(MINIMAX_DEFAULT_MODEL),
  /** `anthropic-version` header value. */
  apiVersion: z.string().default(MINIMAX_DEFAULT_API_VERSION),
  /** Upper bound on generated tokens for one search request. */
  maxTokens: z.number().default(MINIMAX_DEFAULT_MAX_TOKENS),
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: z.number().default(MINIMAX_DEFAULT_MAX_USES),
  /** Maximum continuation rounds after a `pause_turn`. */
  maxContinuations: z.number().default(MINIMAX_DEFAULT_MAX_CONTINUATIONS),
  /** Credential reference holding the MiniMax Token Plan API key. */
  apiKeyEnv: z.string().default('MINIMAX_API_KEY'),
  /**
   * Look for the MiniMax Code grant Our Free Model stores before the API key.
   *
   * Our Free Model runs a MiniMax Code channel of its own and keeps a
   * signed-in grant for it. When that channel is the account in use, its grant
   * is the account the credit endpoint bills.
   */
  preferOfmGrant: z.boolean().default(true),
  /** Our Free Model home; empty means `$DSH_HOME` or `~/.dsh`. */
  ofmHome: z.string().default(''),
  /** The Our Free Model account key that holds the MiniMax Code grant. */
  ofmAccount: z.string().default('minimax-code-global'),
  /** MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax`. */
  minimaxHome: z.string().default(''),
  /** OAuth build environment directory under the MiniMax home. */
  buildEnv: z.string().default('prod'),
  /** OAuth region directory under the MiniMax home. */
  region: z.string().default('en'),
  /** OAuth token endpoint; empty derives it from buildEnv and region. */
  oauthTokenURL: z.string().default(''),
  /** Refresh the OAuth token this long before it expires. */
  refreshSkewMs: z.number().default(600000),
  /** MiniMax Code credit endpoint that answers when the plan is spent. */
  creditBaseURL: z.string().default('https://agent.minimax.io/mavis/api/v1/llm/v1'),
  /** Deadline for one request in milliseconds. */
  timeoutMs: z.number().default(60000),
})

/**
 * This plugin's view of the shared MiniMax Code grant.
 *
 * The grant reader and refresher live in `@local/dsh-minimax-auth`, so this
 * plugin, the credit proxy, and the daily check-in cannot rotate each other's
 * refresh token. Only the error class and code prefix are local.
 */
export class SearchTokenSource extends MinimaxCodeAuth {
  constructor(options) {
    super({ ...options, ErrorClass: MinimaxSearchError, codePrefix: 'MINIMAX_SEARCH_' })
  }

  /**
   * The access token the credit route carries.
   *
   * The grant Our Free Model stores comes first: that plugin drives a
   * MiniMax Code channel of its own, and the grant it keeps is the account
   * the credit route bills. It is read as it stands and never refreshed
   * here — Our Free Model owns that cycle for its own channel. The MiniMax
   * Code desktop grant is the fallback, and the only one this plugin
   * refreshes.
   */
  async token(options = {}) {
    if (this.options.preferOfmGrant === true) {
      const grant = await ofmAccessToken({ ofmHome: this.options.ofmHome, ofmAccount: this.options.ofmAccount })
      if (grant !== undefined) return grant
    }
    return await super.token(options)
  }
}

/** One search result item as MiniMax reports it. */
function isResultItem(item) {
  return item !== null && typeof item === 'object'
    && typeof item.url === 'string' && item.url.length > 0
}

/**
 * Collect the citeable sources from one Messages response.
 *
 * MiniMax returns `web_search_tool_result` blocks whose `content` items carry
 * `title`, `url`, `page_age`, and a short `content` excerpt. The excerpt is
 * the snippet; there is no separate citation block as on Anthropic's own
 * endpoint.
 *
 * @param payload - the parsed Messages response.
 * @returns the deduped sources, in the order MiniMax returned them.
 */
export function collectSources(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const seen = new Set()
  const sources = []
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result') continue
    const items = Array.isArray(block.content) ? block.content : []
    for (const item of items) {
      if (!isResultItem(item)) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({
        url: item.url,
        ...typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {},
        ...typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {},
        ...typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return sources
}

/**
 * The model's own answer text from one Messages response.
 *
 * MiniMax interleaves the lead-in text before the search with the final
 * answer after it. Only the last text block is the answer; earlier ones say
 * "I'll search for that".
 *
 * @param payload - the parsed Messages response.
 * @returns the answer text, or undefined when the response carries none.
 */
export function collectAnswer(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const texts = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
  const last = texts.at(-1)
  return last === undefined ? undefined : last.text
}

/**
 * The search prompt for one query.
 *
 * The wording asks for the search and the answer in one turn, because MiniMax
 * answers on the server side and the reply is what the model reads.
 *
 * @param query - the user's query.
 * @returns the prompt text.
 */
export function searchPrompt(query) {
  return `Perform a web search for the query: ${query}`
}

/**
 * The MiniMax-backed search provider.
 *
 * One search is one Messages request with the native `web_search_20250305`
 * server tool. MiniMax ends a turn with `pause_turn` when it reaches the
 * tool limit; the provider then continues the conversation, exactly as the
 * MiniMax documentation describes, until the model produces its final answer
 * or the continuation budget runs out.
 */
export class MinimaxSearchProvider {
  /**
   * @param resolveOptions - the options for the next operation.
   * @param options.credentials - the credential service, or a thunk returning
   *   it. A thunk is what a plugin passes: the service initializes
   *   asynchronously, so reading `ctx.get('credentials')` while the plugin
   *   applies yields `undefined` for the whole life of the process, and the
   *   Token Plan key would never be found.
   */
  constructor(resolveOptions, options = {}) {
    this.resolveOptions = resolveOptions
    this.tokens = options.tokens
    this.fetchImpl = options.fetchImpl ?? fetch
    this.credentials = typeof options.credentials === 'function'
      ? options.credentials
      : () => options.credentials
  }

  /** Stable id this provider registers under in the search registry. */
  get id() {
    return MINIMAX_SEARCH_PROVIDER_ID
  }

  /** Display name shown in the provider picker. */
  get title() {
    return 'MiniMax'
  }

  /** Picker description: what this provider suits and what it costs. */
  get description() {
    return {
      en: 'Runs the search on MiniMax servers in one request. Each search spends MiniMax tokens from the Token Plan, or credits once the plan is spent.',
      zh: '在 MiniMax 服务器上一次请求完成搜索。每次搜索消耗 Token Plan 的模型 token，额度用完后改为消耗积分。',
      ja: '検索を MiniMax のサーバーで 1 リクエストで実行します。検索ごとに Token Plan のモデルトークンを消費し、プランを使い切るとクレジットから消費します。',
      es: 'Ejecuta la búsqueda en los servidores de MiniMax en una sola solicitud. Cada búsqueda consume tokens del Token Plan, o créditos cuando el plan se agota.',
      fr: 'Exécute la recherche sur les serveurs MiniMax en une seule requête. Chaque recherche consomme des jetons du Token Plan, ou des crédits une fois le plan épuisé.',
      de: 'Führt die Suche in einer Anfrage auf MiniMax-Servern aus. Jede Suche verbraucht Token-Plan-Tokens, nach aufgebrauchtem Plan Guthaben.',
      ru: 'Выполняет поиск на серверах MiniMax одним запросом. Каждый поиск расходует токены Token Plan, а после исчерпания плана — кредиты.',
      pt: 'Executa a pesquisa nos servidores da MiniMax em uma única requisição. Cada pesquisa consome tokens do Token Plan, ou créditos quando o plano acaba.',
    }
  }

  available() {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL)
      && options.model.length > 0
      && numberOf(options.maxTokens) !== undefined && options.maxTokens > 0
      && numberOf(options.maxUses) !== undefined && options.maxUses > 0
  }

  /**
   * Whether a search for a model request on `llmProvider` would have a
   * credential to send. Only configuration is checked; no request is made.
   *
   * @param llmProvider - the provider route of the model request, when known.
   * @returns whether the search could authenticate.
   */
  async ready(llmProvider) {
    const options = this.resolveOptions()
    if (await this.resolveApiKey(options) !== undefined) return true
    // The credit route is the fallback, so its grant decides readiness.
    try {
      return await this.tokens?.token() !== undefined
    } catch {
      return false
    }
  }

  /**
   * Run one search.
   *
   * @param request - the query and the seam's result bound.
   * @param signal - cancellation for the whole search.
   * @returns the normalized result.
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/v1/messages`
    const apiKey = await this.resolveApiKey(options)
    if (apiKey === undefined) {
      throw new MinimaxSearchError(
        `MiniMax search has no API key for "${options.apiKeyEnv}", and the MiniMax Code sign-in cannot be read.`
        + ' Store the key through the credentials service, export it in the launching environment, or sign in to'
        + ' MiniMax Code on this machine so the search can fall over to credits.',
        { code: 'MINIMAX_SEARCH_CREDENTIAL_MISSING' },
      )
    }

    const messages = [{ role: 'user', content: [{ type: 'text', text: searchPrompt(request.query) }] }]
    const sources = new Map()
    let answer
    let rounds = 0

    for (;;) {
      throwIfAborted(signal)
      const payload = await this.dispatch(endpoint, options, apiKey, messages, signal)
      for (const source of collectSources(payload)) {
        if (!sources.has(source.url)) sources.set(source.url, source)
      }
      answer = collectAnswer(payload) ?? answer
      if (payload?.stop_reason !== 'pause_turn') break
      if (rounds >= options.maxContinuations) break
      rounds += 1
      // MiniMax's own rule: append the returned content as an assistant
      // message, unchanged, and ask again.
      messages.push({ role: 'assistant', content: payload.content })
    }

    const list = [...sources.values()]
    if (list.length === 0) {
      throw new MinimaxSearchError(
        'MiniMax returned no web_search_tool_result blocks; the request may not have triggered native web search.',
        { code: 'MINIMAX_SEARCH_NO_RESULTS' },
      )
    }
    return {
      ...answer === undefined ? {} : { content: answer },
      sources: list,
      truncated: false,
    }
  }

  /**
   * The Token Plan key, or undefined when none is configured.
   *
   * The service is read at call time, not at construction: the credential
   * service mounts asynchronously and is still absent when this plugin
   * applies.
   */
  async resolveApiKey(options) {
    let credentials
    try {
      credentials = this.credentials()
    } catch {
      return undefined
    }
    if (credentials === undefined) return undefined
    try {
      const hit = await credentials.resolve(options.apiKeyEnv)
      return hit?.value
    } catch {
      return undefined
    }
  }

  /**
   * Send one Messages request.
   *
   * The plan route answers first. A refusal that names the plan limit is the
   * signal to continue on credits with the MiniMax Code grant, exactly as the
   * credit proxy beside this plugin does.
   */
  async dispatch(endpoint, options, apiKey, messages, signal) {
    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    }
    const response = await this.request(endpoint, options, apiKey, body, signal)
    if (response.ok) return await this.parse(response, endpoint)

    const status = response.status
    const text = await response.text().catch(() => '')
    if (QUOTA_PATTERN.test(text)) {
      await response.body?.cancel().catch(() => {})
      return await this.dispatchCredits(options, body, messages, signal)
    }
    throw new MinimaxSearchError(
      `MiniMax search failed (HTTP ${String(status)}): ${describeErrorBody(text)}`
      + `\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. Search endpoint configuration is separate`
      + ' from chat. Guide the user to check the MiniMax base URL on the Models page, or to set'
      + ' web-minimax-search.baseURL to a trusted MiniMax endpoint. Only the user should choose the endpoint.',
      { code: 'MINIMAX_SEARCH_FAILED' },
    )
  }

  /** Send one request to the plan endpoint. */
  async request(endpoint, options, apiKey, body, signal) {
    try {
      return await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new MinimaxSearchError(`MiniMax search request failed: ${describeError(error)}`, { code: 'MINIMAX_SEARCH_FAILED' })
    }
  }

  /** Parse one successful Messages response. */
  async parse(response, endpoint) {
    try {
      return await response.json()
    } catch (error) {
      throw new MinimaxSearchError(
        `MiniMax returned an unprocessable response body: ${describeError(error)}`,
        { code: 'MINIMAX_SEARCH_FAILED' },
      )
    }
  }

  /**
   * Continue on credits with the MiniMax Code grant.
   *
   * The credit endpoint speaks the same Anthropic Messages format, so the
   * request body is unchanged; only the authentication headers differ.
   */
  async dispatchCredits(options, body, messages, signal) {
    let token
    try {
      token = await this.tokens.token()
    } catch (error) {
      throw new MinimaxSearchError(
        `The MiniMax Token Plan quota is spent and the MiniMax Code sign-in cannot be used: ${describeError(error)}`
        + ' Open MiniMax Code and sign in, or upgrade the Token Plan.',
        { code: 'MINIMAX_SEARCH_CREDENTIAL_MISSING', cause: error },
      )
    }
    const endpoint = `${options.creditBaseURL.replace(/\/+$/u, '')}/messages`
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        // The credit endpoint only accepts the bearer, so the key slot carries a placeholder.
        'x-api-key': 'sk-minimax-credit',
        'anthropic-version': options.apiVersion,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    }).catch(error => {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new MinimaxSearchError(`MiniMax credit search request failed: ${describeError(error)}`, { code: 'MINIMAX_SEARCH_FAILED' })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new MinimaxSearchError(
        `MiniMax credit search failed (HTTP ${String(response.status)}): ${describeErrorBody(text)}`,
        { code: 'MINIMAX_SEARCH_FAILED' },
      )
    }
    return await this.parse(response, endpoint)
  }
}

/** The message of a thrown value. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The readable part of an error body. */
function describeErrorBody(text) {
  if (text.length === 0) return 'the response carried no body'
  try {
    const parsed = JSON.parse(text)
    const detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message
    if (typeof detail === 'string' && detail.length > 0) return detail
  } catch {
    /* a non-JSON body is reported as it arrived */
  }
  return text.slice(0, 300)
}

/** Throw when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw aborted(signal)
}

/** The provider's cancellation error. */
function aborted(signal, fallback) {
  return new MinimaxSearchError('MiniMax search aborted', {
    code: 'MINIMAX_SEARCH_ABORTED',
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/**
 * Mount the MiniMax search provider in `ctx.web`.
 *
 * The provider registers under `minimax-web-search`, so the Web GUI's web
 * search settings page lists it beside the DeepSeek providers and the user
 * can select it as the search provider.
 *
 * @param ctx - the plugin context owning the registration.
 * @param config - the plugin's live configuration.
 */
export function apply(ctx, config) {
  const settings = {
    baseURL: readConfig(config, 'baseURL', MINIMAX_DEFAULT_BASE_URL),
    model: readConfig(config, 'model', MINIMAX_DEFAULT_MODEL),
    apiVersion: readConfig(config, 'apiVersion', MINIMAX_DEFAULT_API_VERSION),
    maxTokens: readConfig(config, 'maxTokens', MINIMAX_DEFAULT_MAX_TOKENS),
    maxUses: readConfig(config, 'maxUses', MINIMAX_DEFAULT_MAX_USES),
    maxContinuations: readConfig(config, 'maxContinuations', MINIMAX_DEFAULT_MAX_CONTINUATIONS),
    apiKeyEnv: readConfig(config, 'apiKeyEnv', 'MINIMAX_API_KEY'),
    preferOfmGrant: readConfig(config, 'preferOfmGrant', true),
    ofmHome: readConfig(config, 'ofmHome', ''),
    ofmAccount: readConfig(config, 'ofmAccount', 'minimax-code-global'),
    minimaxHome: readConfig(config, 'minimaxHome', ''),
    buildEnv: readConfig(config, 'buildEnv', 'prod'),
    region: readConfig(config, 'region', 'en'),
    oauthTokenURL: readConfig(config, 'oauthTokenURL', ''),
    refreshSkewMs: readConfig(config, 'refreshSkewMs', 600000),
    creditBaseURL: readConfig(config, 'creditBaseURL', 'https://agent.minimax.io/mavis/api/v1/llm/v1'),
    timeoutMs: readConfig(config, 'timeoutMs', 60000),
  }
  const oauthTokenURL = settings.oauthTokenURL || `${oauthAccountOrigin(settings.region)}/oauth2/token`
  const tokens = new SearchTokenSource({
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
  const provider = new MinimaxSearchProvider(() => ({ ...settings }), {
    tokens,
    fetchImpl: fetch,
    // The credential service is optional: without it the provider still works
    // through the MiniMax Code grant. It is looked up per search rather than
    // captured here, because it mounts asynchronously and is still absent while
    // this plugin applies.
    credentials: () => ctx.get('credentials'),
  })
  ctx.web.registerSearchProvider({
    id: provider.id,
    title: provider.title,
    description: provider.description,
    available: () => provider.available(),
    ready: llmProvider => provider.ready(llmProvider),
    search: (request, signal) => provider.search(request, signal),
  })
}
