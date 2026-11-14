// Exercise the plugin's MiniMax check-in client against the live API.
// Usage: node scripts/checkin-live.mjs [status|claim]
import { MinimaxAuth, SigninClient, oauthTokenURLFor } from '../index.js'

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

const action = process.argv[2] ?? 'status'
try {
  if (action === 'status') {
    const panel = await client.panel()
    console.log(JSON.stringify(panel, null, 2))
  } else {
    const result = await client.claim()
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error('FAILED:', error?.message ?? String(error), 'code:', error?.code)
  process.exitCode = 1
}
