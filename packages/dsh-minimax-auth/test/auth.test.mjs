import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTH_MESSAGES, MinimaxCodeAuth, numberOf, oauthAccountOrigin, readConfig } from '../index.js'

test('the region selects the account origin', () => {
  assert.equal(oauthAccountOrigin('cn'), 'https://account.minimax.cn')
  assert.equal(oauthAccountOrigin('en'), 'https://account.minimax.io')
  assert.equal(oauthAccountOrigin('anything'), 'https://account.minimax.io')
})

test('a caller keeps its own error class and code prefix', async () => {
  class WidgetError extends Error {
    constructor(message, options = {}) {
      super(message, options)
      this.name = 'WidgetError'
      this.code = options.code
    }
  }
  const auth = new MinimaxCodeAuth({
    minimaxHome: 'Z:\\definitely-not-here',
    buildEnv: 'prod',
    region: 'en',
    tokenURL: 'https://example.invalid/oauth2/token',
    refreshSkewMs: 600000,
    fetchImpl: fetch,
    ErrorClass: WidgetError,
    codePrefix: 'MINIMAX_WIDGET_',
  })
  const failure = auth.fail('NO_SIGN_IN', AUTH_MESSAGES.noSignIn)
  assert.ok(failure instanceof WidgetError)
  assert.equal(failure.code, 'MINIMAX_WIDGET_NO_SIGN_IN')
  assert.equal(failure.name, 'WidgetError')

  await assert.rejects(auth.token(), error => error instanceof WidgetError && error.code === 'MINIMAX_WIDGET_NO_SIGN_IN')
  const status = await auth.status()
  assert.equal(status.ok, false)
  assert.equal(status.code, 'MINIMAX_WIDGET_NO_SIGN_IN')
  assert.equal(status.reason, AUTH_MESSAGES.noSignIn)
})

test('the namespace is derived from the home, build environment, and region', () => {
  const auth = new MinimaxCodeAuth({ minimaxHome: 'C:\\mm', buildEnv: 'prod', region: 'en' })
  const paths = auth.paths()
  assert.equal(paths.buildEnv, 'prod')
  assert.equal(paths.region, 'en')
  assert.ok(paths.namespaceHome.endsWith('mcode-public'))
  assert.ok(paths.namespaceHome.includes('prod'))
  assert.ok(paths.namespaceHome.includes('en'))
  assert.equal(paths.lockPath, `${paths.credentialPath.replace(/auth\.json$/u, 'auth.lock')}`)
  assert.ok(paths.recordKey.startsWith('com.minimax.mcode.oauth.prod.en\0'))
})

test('the helpers keep their contract', () => {
  assert.equal(numberOf(0), 0)
  assert.equal(numberOf(Number.NaN), undefined)
  assert.equal(numberOf('1'), undefined)
  assert.equal(readConfig({ a: 1 }, 'a', 2), 1)
  assert.equal(readConfig({}, 'a', 2), 2)
  assert.equal(readConfig({ a: { get: () => 3 } }, 'a', 2), 3)
})
