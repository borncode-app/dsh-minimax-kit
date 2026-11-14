#!/usr/bin/env node
// Offline tests for the MiniMax credit proxy: decision, failover, auth, relay.
// Run: node test-proxy.mjs
import assert from 'node:assert/strict'
import { CreditBalance, MinimaxCreditProxy, QUOTA_PATTERN } from './index.js'

const QUOTA_TEXT = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)' } })

function fakeTokens(initial = { accessToken: 'mmoat_test', expiresAtMs: Date.now() + 3600000 }) {
  let current = { ...initial }
  let refreshes = 0
  return {
    get refreshes() { return refreshes },
    async token(options = {}) {
      if (options.force === true) { refreshes += 1; current = { accessToken: `mmoat_refreshed_${refreshes}`, expiresAtMs: Date.now() + 3600000 } }
      return current.accessToken
    },
    async peekToken() { return current.accessToken },
    async status() { return { ok: true, source: 'miniMaxCode', expiresInMs: 3600000, needsRefresh: false, refreshing: false } },
  }
}

function fakeQuota(reading) {
  return {
    value: reading,
    peek() { return this.value },
    async check() { return this.value },
    markExhausted() { this.value = { exhausted: true, percent: 0, at: new Date().toISOString(), source: 'plan-error' } },
  }
}

/** A fetch stub that answers by URL and records calls. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers, body: options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body.toString() : String(options.body) })
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return handler(options)
    }
    return new Response('no route', { status: 599 })
  }
  impl.calls = calls
  return impl
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function startProxy(overrides) {
  const proxy = new MinimaxCreditProxy({
    enabled: overrides.enabled ?? true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    planBaseURL: 'https://plan.test/anthropic',
    creditBaseURL: 'https://credit.test/mavis/api/v1/llm/v1',
    fetchImpl: overrides.fetchImpl,
    tokens: overrides.tokens ?? fakeTokens(),
    quota: overrides.quota ?? fakeQuota(undefined),
    credits: overrides.credits,
    logger: undefined,
  })
  await proxy.listen()
  return proxy
}

const messageBody = { model: 'MiniMax-M3.1-Flash', max_tokens: 16, messages: [{ role: 'user', content: 'Say OK.' }] }

async function postMessages(proxy, headers = {}) {
  return fetch(`${proxy.url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-cp-test', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(messageBody),
  })
}

const checks = []
async function check(name, run) {
  try {
    await run()
    checks.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.log(`FAIL  ${name} — ${error.message}`)
  }
}

// ── 1. quota still available: the plan route answers and credits stay unused ──
await check('plan route answers while the plan has quota', async () => {
  const fetchImpl = fakeFetch([
    ['plan.test', () => new Response('event: message_stop\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })],
    ['credit.test', () => { throw new Error('credit route must not be called') }],
  ])
  const quota = fakeQuota({ exhausted: false, percent: 55, at: new Date().toISOString() })
  const proxy = await startProxy({ fetchImpl, quota })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'event: message_stop\n\n')
    assert.equal(proxy.stats.planned, 1)
    assert.equal(proxy.stats.credited, 0)
    assert.equal(fetchImpl.calls.length, 1)
    assert.match(fetchImpl.calls[0].url, /^https:\/\/plan\.test\/anthropic\/v1\/messages$/)
    assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'sk-cp-test')
  } finally { await proxy.close() }
})

// ── 2. quota spent: the request skips the plan entirely ──────────────────────
await check('spent quota dispatches straight to credits with the OAuth bearer', async () => {
  const tokens = fakeTokens()
  const fetchImpl = fakeFetch([
    ['credit.test', () => json({ id: 'msg_credit', type: 'message', content: [{ text: 'OK', type: 'text' }] })],
    ['plan.test', () => { throw new Error('plan route must not be called') }],
  ])
  const proxy = await startProxy({ fetchImpl, tokens, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /msg_credit/u)
    assert.equal(proxy.stats.credited, 1)
    assert.match(fetchImpl.calls[0].url, /^https:\/\/credit\.test\/mavis\/api\/v1\/llm\/v1\/messages$/)
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer mmoat_test')
    assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'sk-minimax-credit')
    assert.equal(fetchImpl.calls[0].body, JSON.stringify(messageBody))
  } finally { await proxy.close() }
})

// ── 3. stale quota reading: a 429 refusal mid-flight still fails over ───────
await check('plan 429 quota refusal fails over and is remembered', async () => {
  const fetchImpl = fakeFetch([
    ['plan.test', () => new Response(QUOTA_TEXT, { status: 429, headers: { 'content-type': 'application/json' } })],
    ['credit.test', () => json({ id: 'msg_fallback', type: 'message' })],
  ])
  const quota = fakeQuota({ exhausted: false, percent: 30, at: new Date().toISOString() })
  const proxy = await startProxy({ fetchImpl, quota })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /msg_fallback/u)
    assert.equal(proxy.stats.fallbacks, 1)
    assert.equal(proxy.stats.credited, 1)
    assert.equal(quota.peek().exhausted, true)
    const status = await proxy.status()
    assert.equal(status.mode, 'credits')
  } finally { await proxy.close() }
})

// ── 4a. a transient 401 retries the same token without touching the grant ───
await check('transient credit 401 retries with the same token', async () => {
  const tokens = fakeTokens()
  let creditCalls = 0
  const fetchImpl = fakeFetch([
    ['credit.test', () => {
      creditCalls += 1
      if (creditCalls === 1) return json({ code: 401, message: 'invalid access token' }, 401)
      return json({ id: 'msg_transient', type: 'message' })
    }],
  ])
  const proxy = await startProxy({ fetchImpl, tokens, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /msg_transient/u)
    assert.equal(tokens.refreshes, 0)
    assert.equal(creditCalls, 2)
    assert.equal(fetchImpl.calls[1].headers.authorization, 'Bearer mmoat_test')
  } finally { await proxy.close() }
})

// ── 4b. a second 401 forces a refresh, then the retry succeeds ─────────────
await check('second credit 401 refreshes the OAuth token and retries', async () => {
  const tokens = fakeTokens()
  let creditCalls = 0
  const fetchImpl = fakeFetch([
    ['credit.test', () => {
      creditCalls += 1
      if (creditCalls <= 2) return json({ code: 401, message: 'invalid access token' }, 401)
      return json({ id: 'msg_after_refresh', type: 'message' })
    }],
  ])
  const proxy = await startProxy({ fetchImpl, tokens, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /msg_after_refresh/u)
    assert.equal(tokens.refreshes, 1)
    assert.equal(creditCalls, 3)
    assert.equal(fetchImpl.calls[2].headers.authorization, 'Bearer mmoat_refreshed_1')
  } finally { await proxy.close() }
})

// ── 4c. a disabled-thinking refusal is retried without the thinking switch ─
await check('disabled thinking is relaxed once when the credit route demands adaptive', async () => {
  const target = { model: 'MiniMax-M3.1-Flash', max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Say OK.' }, { role: 'system', content: [], output_config: { effort: 'none' } }] }
  let creditCalls = 0
  const fetchImpl = fakeFetch([
    ['credit.test', (options) => {
      creditCalls += 1
      if (creditCalls === 1) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking (2013)' } }, 400)
      return json({ id: 'msg_relaxed', type: 'message' })
    }],
  ])
  const proxy = await startProxy({ fetchImpl, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-cp-test', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(target),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /msg_relaxed/u)
    const retried = JSON.parse(fetchImpl.calls[1].body)
    assert.equal(retried.thinking, undefined)
    assert.equal(retried.messages[1].output_config, undefined)
    assert.equal(retried.messages[0].content, 'Say OK.')
  } finally { await proxy.close() }
})

// ── 5. a non-quota plan failure passes through untouched ────────────────────
await check('non-quota plan failure passes through without falling back', async () => {
  const fetchImpl = fakeFetch([
    ['plan.test', () => json({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }, 400)],
    ['credit.test', () => { throw new Error('credit route must not be called') }],
  ])
  const proxy = await startProxy({ fetchImpl, quota: fakeQuota({ exhausted: false, percent: 50, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 400)
    assert.match(await response.text(), /bad request/u)
    assert.equal(proxy.stats.fallbacks, 0)
  } finally { await proxy.close() }
})

// ── 6. a non-quota 429 is not a quota refusal ───────────────────────────────
await check('transient 429 wording is not treated as a spent plan', async () => {
  assert.equal(QUOTA_PATTERN.test('{"error":{"message":"rate limit: too many requests"}}'), false)
  assert.equal(QUOTA_PATTERN.test(QUOTA_TEXT), true)
})

// ── 7. model listing stays on the plan route ────────────────────────────────
await check('models listing forwards to the plan endpoint', async () => {
  const fetchImpl = fakeFetch([
    ['/v1/models', () => json({ data: [{ id: 'MiniMax-M3.1-Flash' }] })],
  ])
  const proxy = await startProxy({ fetchImpl, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/models?limit=1000`, { headers: { 'x-api-key': 'sk-cp-test' } })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /MiniMax-M3\.1-Flash/u)
    assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'sk-cp-test')
  } finally { await proxy.close() }
})

// ── 8. status reading shape ─────────────────────────────────────────────────
await check('status reports mode, plan, token, credits, and counters', async () => {
  const fetchImpl = fakeFetch([])
  const tokens = fakeTokens()
  const credits = new CreditBalance({
    creditURL: 'https://api.test/backend/account/token_plan_credit',
    membershipURL: 'https://agent.test/matrix/api/v1/commerce/get_membership_info',
    walletURL: 'https://api.test/account/query_balance',
    cacheMs: 60000,
    fetchImpl: fakeFetch([
      ['get_membership_info', () => json({ has_token_plan: true, token_plan_tier: 'Go', token_plan_expires_at: Date.now() + 86400000, op_credit_summary: { total_remaining_amount: '4002.482', purchased_remaining_amount: '0', free_remaining_amount: '4002.482' } })],
      ['token_plan_credit', () => json({ total_credits: 500, used_credits: 120, remaining_credits: 380, token_plan_credit_fallback_enabled: true, enable_credit_first_for_high_cost: false })],
      ['query_balance', () => json({ available_amount: '1.50', cash_balance: '1.00', voucher_balance: '0.00', credit_balance: '0.50', owed_amount: '0.00' })],
    ]),
  })
  const proxy = await startProxy({ fetchImpl, tokens, credits, quota: fakeQuota({ exhausted: true, percent: 0, weeklyPercent: 22, resetInMs: 3600000, at: new Date().toISOString() }) })
  try {
    const status = await proxy.status()
    assert.equal(status.enabled, true)
    assert.equal(status.mode, 'credits')
    assert.equal(status.plan.percent, 0)
    // The countdown is taken from the probe time, so the floor minute drifts by one.
    assert.match(status.plan.resetIn, /^(59m|1h 0m)$/u)
    assert.equal(status.token.ok, true)
    assert.deepEqual(status.stats, { planned: 0, credited: 0, fallbacks: 0, errors: 0, refused: 0 })
    assert.equal(status.credits.ok, true)
    assert.equal(status.credits.remaining, 4002)
    assert.equal(status.credits.remainingExact, 4002.482)
    assert.equal(status.credits.freeRemaining, 4002.482)
    assert.equal(status.credits.purchasedRemaining, 0)
    assert.equal(status.credits.plan.tier, 'Go')
    assert.equal(status.credits.fallbackEnabled, true)
    assert.equal(status.credits.wallet.credit, 0.5)
    assert.equal(status.credits.wallet.available, 1.5)
    const response = await fetch(`${proxy.url}/status`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.mode, 'credits')
    assert.equal(body.credits.remaining, 4002)
  } finally { await proxy.close() }
})

// ── 8b. credit balance parsing, caching, and partial failure ────────────────
await check('credit balance reads the membership summary and caches it', async () => {
  const fetchImpl = fakeFetch([
    ['get_membership_info', () => json({ has_token_plan: true, token_plan_tier: 'Plus', op_credit_summary: { total_remaining_amount: '1234.9', purchased_remaining_amount: '1000', free_remaining_amount: '234.9' } })],
    ['token_plan_credit', () => json({ total_credits: 2, used_credits: 0, remaining_credits: 2, token_plan_credit_fallback_enabled: false })],
    ['query_balance', () => json({ available_amount: '3.25', cash_balance: '3.00', voucher_balance: '0.25', credit_balance: '0.00', owed_amount: '0.10' })],
  ])
  const credits = new CreditBalance({
    creditURL: 'https://api.test/backend/account/token_plan_credit',
    membershipURL: 'https://agent.test/matrix/api/v1/commerce/get_membership_info',
    walletURL: 'https://api.test/account/query_balance',
    cacheMs: 60000,
    fetchImpl,
  })
  const first = await credits.read('mmoat_test')
  assert.equal(first.ok, true)
  assert.equal(first.remaining, 1234)
  assert.equal(first.remainingExact, 1234.9)
  assert.equal(first.purchasedRemaining, 1000)
  assert.equal(first.freeRemaining, 234.9)
  assert.equal(first.plan.tier, 'Plus')
  assert.equal(first.fallbackEnabled, false)
  assert.equal(first.wallet.cash, 3)
  assert.equal(first.wallet.owed, 0.1)
  assert.equal(fetchImpl.calls.length, 3)
  const second = await credits.read('mmoat_test')
  assert.equal(second, first)
  assert.equal(fetchImpl.calls.length, 3)

  const broken = new CreditBalance({
    creditURL: 'https://api.test/backend/account/token_plan_credit',
    membershipURL: 'https://agent.test/matrix/api/v1/commerce/get_membership_info',
    walletURL: 'https://api.test/account/query_balance',
    cacheMs: 0,
    fetchImpl: fakeFetch([
      ['get_membership_info', () => new Response('nope', { status: 500 })],
      ['token_plan_credit', () => new Response('nope', { status: 500 })],
      ['query_balance', () => new Response('nope', { status: 500 })],
    ]),
  })
  const missing = await broken.read('mmoat_test')
  assert.equal(missing.ok, false)
  assert.equal(missing.remaining, undefined)
})

// ── 9. proxy disabled: no fallback, plan refusal passes through ─────────────
await check('disabled proxy relays the plan refusal unchanged', async () => {
  const fetchImpl = fakeFetch([
    ['plan.test', () => new Response(QUOTA_TEXT, { status: 429, headers: { 'content-type': 'application/json' } })],
  ])
  const proxy = await startProxy({ enabled: false, fetchImpl, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 429)
    assert.match(await response.text(), /Token Plan usage limit reached/u)
    assert.equal(proxy.stats.credited, 0)
  } finally { await proxy.close() }
})

// ── 10. streamed plan body is relayed chunk for chunk ───────────────────────
await check('streamed plan body relays intact', async () => {
  const chunks = ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n']
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  const fetchImpl = fakeFetch([
    ['plan.test', () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })],
  ])
  const proxy = await startProxy({ fetchImpl, quota: fakeQuota({ exhausted: false, percent: 80, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(await response.text(), chunks.join(''))
  } finally { await proxy.close() }
})

// ── 11. a missing sign-in surfaces as a 503 with guidance ───────────────────
await check('unavailable MiniMax sign-in answers 503 with guidance', async () => {
  const { CreditUnavailableError } = await import('./index.js')
  const tokens = {
    async token() { throw new CreditUnavailableError('MiniMax Code is not signed in on this machine; open MiniMax Code and sign in so credit fallback can run.', { code: 'MINIMAX_CREDIT_NO_SIGN_IN' }) },
    async status() { return { ok: false, source: 'miniMaxCode', reason: 'not signed in', code: 'MINIMAX_CREDIT_NO_SIGN_IN' } },
  }
  const fetchImpl = fakeFetch([
    ['plan.test', () => new Response(QUOTA_TEXT, { status: 429, headers: { 'content-type': 'application/json' } })],
  ])
  const proxy = await startProxy({ fetchImpl, tokens, quota: fakeQuota({ exhausted: true, percent: 0, at: new Date().toISOString() }) })
  try {
    const response = await postMessages(proxy)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /not signed in/u)
  } finally { await proxy.close() }
})

// ── 12. the weekly window is a second cap on the plan ───────────────────────
await check('a zero weekly reading marks the plan spent', async () => {
  const { PlanQuota } = await import('./index.js')
  const readingOf = async (windowPercent, weeklyPercent) => {
    const quota = new PlanQuota({
      url: 'https://plan.test/coding_plan/remains',
      cacheMs: 60000,
      fetchImpl: async () => json({
        model_remains: [{
          model_name: 'general',
          current_interval_remaining_percent: windowPercent,
          current_weekly_remaining_percent: weeklyPercent,
          remains_time: 60000,
          weekly_remains_time: 600000,
        }],
      }),
    })
    return await quota.check('sk-cp-test')
  }
  // The short window still has quota, but the weekly cap is spent: the plan
  // endpoint refuses, so the plugin must count this as an exhausted plan.
  const weekly = await readingOf(40, 0)
  assert.equal(weekly.exhausted, true)
  assert.equal(weekly.percent, 40)
  assert.equal(weekly.weeklyPercent, 0)
  const spent = await readingOf(0, 55)
  assert.equal(spent.exhausted, true)
  const healthy = await readingOf(40, 55)
  assert.equal(healthy.exhausted, false)
  assert.equal(healthy.weeklyPercent, 55)
})

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
