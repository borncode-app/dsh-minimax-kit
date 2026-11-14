#!/usr/bin/env node
// Live check of the OAuth refresh path: rotates the MiniMax Code grant once,
// writes the rotated grant back in the app's own file format, and verifies the
// new token against the credit endpoint. Restores a backup on failure.
// Run: node test-refresh.mjs
import { cp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TokenSource, oauthTokenURLFor } from './index.js'

const namespace = join(homedir(), '.minimax', 'auth', 'prod', 'en', 'mcode-public')
const backupRoot = join(process.cwd(), '..', '_probe', 'minimax-credit-backups', 'refresh')
const backup = join(backupRoot, String(Date.now()))
await cp(namespace, backup, { recursive: true })
console.log(`backup: ${backup}`)

const tokens = new TokenSource({
  minimaxHome: '',
  buildEnv: 'prod',
  region: 'en',
  tokenURL: oauthTokenURLFor('prod', 'en'),
  refreshSkewMs: 600000,
  fetchImpl: fetch,
})

async function verifyFiles() {
  const credential = JSON.parse(await readFile(join(namespace, 'auth.json'), 'utf8'))
  const state = JSON.parse(await readFile(join(namespace, 'auth-state.json'), 'utf8'))
  const recordKey = Object.keys(credential.records).find(key => key.includes('com.minimax.mcode.oauth.prod.en'))
  const record = credential.records[recordKey]
  console.log(`files: generation record=${record.generation} state=${state.generation} status=${state.status} expiresInMin=${Math.round((record.expiresAtMs - Date.now()) / 60000)}`)
  if (record.generation !== state.generation) throw new Error('generation mismatch between credential and state')
  if (state.status !== 'authenticated') throw new Error(`unexpected state status ${state.status}`)
  if (!(record.expiresAtMs > Date.now())) throw new Error('rotated credential is already expired')
  if (typeof record.refreshToken !== 'string' || record.refreshToken.length === 0) throw new Error('rotated credential lost its refresh token')
  return record
}

async function verifyToken(token) {
  const response = await fetch('https://agent.minimax.io/mavis/api/v1/llm/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${token}`, 'x-api-key': 'sk-minimax-credit' },
    body: JSON.stringify({ model: 'MiniMax-M3.1-Flash', max_tokens: 16, messages: [{ role: 'user', content: 'Say OK.' }] }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  console.log(`credit endpoint with rotated token: HTTP ${response.status} ${text.slice(0, 160)}`)
  if (!response.ok) throw new Error(`rotated token refused: HTTP ${response.status}`)
}

let ok = false
try {
  const token = await tokens.token({ force: true })
  const record = await verifyFiles()
  await verifyToken(token)
  ok = true
  console.log('PASS  forced refresh wrote a consistent grant and the new token works')
} catch (error) {
  console.log(`FAIL  ${error.message}`)
  await rm(namespace, { recursive: true, force: true })
  await cp(backup, namespace, { recursive: true })
  console.log('restored the original grant from backup')
} finally {
  const status = await tokens.status()
  console.log(`token status after run: ${JSON.stringify(status)}`)
  if (ok) console.log(`new grant kept; backup retained at ${backup}`)
  else process.exitCode = 1
}
