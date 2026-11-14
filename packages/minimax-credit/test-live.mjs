#!/usr/bin/env node
// Live check against MiniMax's real endpoints through the proxy: the plan key is
// read from the Harness credential store and the OAuth token from MiniMax Code.
// Run: node test-live.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CreditBalance, MinimaxCreditProxy, PlanQuota, TokenSource, oauthTokenURLFor } from './index.js'

const credentialsText = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const line = credentialsText.split('\n').find(entry => entry.trim().startsWith('MINIMAX_API_KEY:'))
const apiKey = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
assert.ok(apiKey.startsWith('sk-'), 'MINIMAX_API_KEY must resolve to a MiniMax key')

const tokens = new TokenSource({
  minimaxHome: '',
  buildEnv: 'prod',
  region: 'en',
  tokenURL: oauthTokenURLFor('prod', 'en'),
  refreshSkewMs: 600000,
  fetchImpl: fetch,
})
const quota = new PlanQuota({
  url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  cacheMs: 0,
  fetchImpl: fetch,
})
const credits = new CreditBalance({
  creditURL: 'https://api.minimax.io/backend/account/token_plan_credit',
  membershipURL: 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info',
  walletURL: 'https://api.minimax.io/account/query_balance',
  cacheMs: 0,
  fetchImpl: fetch,
})
const proxy = new MinimaxCreditProxy({
  enabled: true,
  listenHost: '127.0.0.1',
  listenPort: 0,
  planBaseURL: 'https://api.minimax.io/anthropic',
  creditBaseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
  fetchImpl: fetch,
  tokens,
  quota,
  credits,
  resolveApiKey: async () => apiKey,
})
await proxy.listen()
console.log(`proxy listening at ${proxy.url}`)
console.log('token status:', JSON.stringify(await tokens.status()))
console.log('quota reading:', JSON.stringify(await quota.check(apiKey)))

const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
const body = { model: 'MiniMax-M3.1-Flash', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }

const checks = []
async function check(name, run) {
  try {
    await run()
    checks.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    checks.push({ name, ok: false })
    console.log(`FAIL  ${name} — ${error.message}`)
  }
}

await check('non-stream message continues on credits while the plan is spent', async () => {
  const response = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  console.log(`      HTTP ${response.status} ${text.slice(0, 300)}`)
  assert.equal(response.status, 200, text)
  assert.match(text, /OK/u)
})

await check('streaming message continues on credits with SSE', async () => {
  const response = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, max_tokens: 64, stream: true }) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)
  const text = await response.text()
  console.log(`      SSE bytes=${text.length} events=${(text.match(/^event: /gmu) ?? []).length}`)
  assert.match(text, /message_start/u)
  assert.match(text, /message_stop/u)
  assert.match(text, /content_block/u)
})

await check('model listing travels the plan route', async () => {
  const response = await fetch(`${proxy.url}/anthropic/v1/models?limit=1000`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } })
  const text = await response.text()
  console.log(`      HTTP ${response.status} ${text.slice(0, 200)}`)
  assert.ok([200, 404].includes(response.status), `unexpected status ${response.status}`)
})

await check('status endpoint reports plan, credit mode, and credits', async () => {
  const response = await fetch(`${proxy.url}/status`)
  const status = await response.json()
  console.log('      status:', JSON.stringify({ mode: status.mode, plan: status.plan, credits: status.credits, token: status.token, stats: status.stats }))
  assert.equal(response.status, 200)
  assert.equal(status.mode, 'credits')
  assert.equal(status.plan.percent, 0)
  assert.equal(status.token.ok, true)
  assert.ok(status.stats.credited >= 2)
  assert.equal(status.credits.ok, true)
  assert.equal(typeof status.credits.remaining, 'number')
  assert.equal(typeof status.credits.wallet.credit, 'number')
})

await check('credit balance reads the live account numbers (membership summary)', async () => {
  const token = await tokens.peekToken()
  assert.ok(typeof token === 'string' && token.length > 0, 'a usable OAuth token is required')
  const reading = await credits.read(token)
  console.log('      credits:', JSON.stringify(reading))
  assert.equal(reading.ok, true)
  assert.equal(typeof reading.remaining, 'number')
  assert.equal(reading.remaining, Math.floor(reading.remainingExact))
  assert.equal(typeof reading.plan.tier, 'string')
  assert.equal(typeof reading.fallbackEnabled, 'boolean')
  assert.equal(typeof reading.wallet.available, 'number')
})

await proxy.close()
const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} live checks passed`)
if (failed.length > 0) process.exitCode = 1
