import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AUTH_MESSAGES, MinimaxCodeAuth } from '../index.js'

class WidgetError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'WidgetError'
    this.code = options.code
  }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-minimax-auth-'))
  const namespace = join(home, 'auth', 'prod', 'en', 'mcode-public')
  await mkdir(namespace, { recursive: true })
  return { home, namespace }
}

test('a near-expiry grant is refreshed in place and the files are rewritten', async () => {
  const { home, namespace } = await makeHome()
  try {
    const auth = new MinimaxCodeAuth({ minimaxHome: home, buildEnv: 'prod', region: 'en' })
    const paths = auth.paths()
    const record = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAtMs: Date.now() + 1000,
      generation: 7,
    }
    await writeFile(paths.credentialPath, JSON.stringify({ schemaVersion: 1, records: { [paths.recordKey]: record } }))

    const calls = []
    const instance = new MinimaxCodeAuth({
      minimaxHome: home,
      buildEnv: 'prod',
      region: 'en',
      tokenURL: 'https://example.invalid/oauth2/token',
      refreshSkewMs: 600000,
      timeoutMs: 5000,
      ErrorClass: WidgetError,
      codePrefix: 'MINIMAX_WIDGET_',
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init.body.toString() })
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'agent.default',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const token = await instance.token()
    assert.equal(token, 'new-access')
    assert.equal(calls.length, 1)
    assert.match(calls[0].body, /grant_type=refresh_token/u)
    assert.match(calls[0].body, /refresh_token=old-refresh/u)

    const credential = JSON.parse(await readFile(paths.credentialPath, 'utf8'))
    const written = credential.records[paths.recordKey]
    assert.equal(written.accessToken, 'new-access')
    assert.equal(written.refreshToken, 'new-refresh')
    assert.equal(written.generation, 8)
    assert.ok(written.expiresAtMs > Date.now())

    const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
    assert.equal(state.generation, 8)
    assert.equal(state.status, 'authenticated')
    assert.equal(state.buildEnv, 'prod')
    assert.equal(state.region, 'en')

    // The lock directory is released, so a second refresh can take it.
    assert.deepEqual((await auth.status()).ok, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a live token inside the skew window needs no refresh', async () => {
  const { home } = await makeHome()
  try {
    const auth = new MinimaxCodeAuth({ minimaxHome: home, buildEnv: 'prod', region: 'en' })
    const paths = auth.paths()
    await writeFile(paths.credentialPath, JSON.stringify({
      schemaVersion: 1,
      records: { [paths.recordKey]: { accessToken: 'still-good', refreshToken: 'r', expiresAtMs: Date.now() + 3600000 } },
    }))
    let fetched = 0
    const instance = new MinimaxCodeAuth({
      minimaxHome: home,
      buildEnv: 'prod',
      region: 'en',
      tokenURL: 'https://example.invalid/oauth2/token',
      refreshSkewMs: 600000,
      fetchImpl: async () => { fetched += 1; throw new Error('must not fetch') },
    })
    assert.equal(await instance.token(), 'still-good')
    assert.equal(await instance.peekToken(), 'still-good')
    assert.equal(fetched, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an expired grant the service rejects reports the caller error class', async () => {
  const { home } = await makeHome()
  try {
    const auth = new MinimaxCodeAuth({ minimaxHome: home, buildEnv: 'prod', region: 'en' })
    const paths = auth.paths()
    await writeFile(paths.credentialPath, JSON.stringify({
      schemaVersion: 1,
      records: { [paths.recordKey]: { accessToken: 'old', refreshToken: 'dead', expiresAtMs: Date.now() + 1000 } },
    }))
    const instance = new MinimaxCodeAuth({
      minimaxHome: home,
      buildEnv: 'prod',
      region: 'en',
      tokenURL: 'https://example.invalid/oauth2/token',
      refreshSkewMs: 600000,
      ErrorClass: WidgetError,
      codePrefix: 'MINIMAX_WIDGET_',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    })
    await assert.rejects(instance.token(), error => (
      error instanceof WidgetError
      && error.code === 'MINIMAX_WIDGET_SIGN_IN_EXPIRED'
      && error.message === AUTH_MESSAGES.expired
    ))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
