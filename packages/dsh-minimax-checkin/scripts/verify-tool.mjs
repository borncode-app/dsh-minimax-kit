// Runs the plugin's real tool against the real MiniMax API and passes the
// result through the Harness's own lossless-JSON validator.
//
// The validator is the one the Harness uses, extracted verbatim from
// @deepseek-ai/dsh-api-session-controller/lib/client.js so this check cannot
// drift from the rule that actually rejects a tool result.
//
// Usage: node scripts/verify-tool.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../../_dsh_src/@deepseek-ai/dsh-api-session-controller/lib/client.js', import.meta.url)),
  'utf8',
)

const start = source.indexOf('function hasIntrinsicConstructor(')
const end = source.indexOf('function deepFreeze(')
if (start < 0 || end < 0) throw new Error('could not find the validator in the Harness source')
const body = source.slice(start, end)

const validate = new Function(`${body}
  return function (value) {
    const snapshot = snapshotJsonValue(value)
    return snapshot === undefined ? undefined : snapshot
  }
`)()

const { MinimaxAuth, SigninClient, oauthTokenURLFor, jsonSafe } = await import('../index.js')

const auth = new MinimaxAuth({
  minimaxHome: '',
  buildEnv: 'prod',
  region: 'en',
  tokenURL: oauthTokenURLFor('en'),
  refreshSkewMs: 600000,
  timeoutMs: 20000,
  fetchImpl: fetch,
})
const client = new SigninClient({
  apiBaseURL: 'https://agent.minimax.io',
  appVersion: '3.1.14',
  timeoutMs: 20000,
  auth,
})

/** The tool result, exactly as the plugin's execute() builds it. */
async function toolResult(action) {
  const status = {
    ok: true,
    action: 'status',
    panel: client.panel ? await client.panel() : null,
    token: await auth.status(),
    lastClaim: undefined,
    lastError: undefined,
  }
  if (action === 'status') {
    return jsonSafe({
      ok: status.ok,
      action: 'status',
      panel: status.panel,
      token: status.token,
      lastClaim: status.lastClaim,
      lastError: status.lastError,
    })
  }
  const result = await client.claim()
  return jsonSafe({
    ok: true,
    action: 'claim',
    claimed: result.claimResult === 1,
    alreadyClaimed: result.claimResult === 2,
    dayNo: result.dayNo,
    points: result.points,
    panel: result.panel,
  })
}

// The shape the plugin returned before the fix: the same fields, with the
// undefined ones left in place.
const before = {
  ok: true,
  action: 'status',
  panel: await client.panel(),
  token: await auth.status(),
  lastClaim: undefined,
  lastError: undefined,
}

console.log('without the fix :', validate(before) === undefined ? 'REJECTED (not lossless)' : 'accepted')
const after = await toolResult('status')
console.log('with the fix    :', validate(after) === undefined ? 'REJECTED (not lossless)' : 'accepted')

if (validate(after) === undefined) {
  console.error('\nFAIL: the tool result is still not lossless')
  process.exitCode = 1
} else {
  console.log('\nOK: the Harness validator accepts the tool result')
}
