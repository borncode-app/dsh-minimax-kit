import assert from 'node:assert/strict'
import test from 'node:test'

import { jsonSafe, localDayKey, millisUntilHour, md5, normalizePanel, oauthTokenURLFor } from '../index.js'

/**
 * The Harness refuses a tool result that cannot round-trip through JSON
 * without losing anything. This mirrors that rule: no `undefined`, no
 * non-finite number, plain objects and arrays only.
 */
function assertLossless(value, path = 'value') {
  if (value === null) return
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return
  if (kind === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number`)
    assert.ok(!Object.is(value, -0), `${path} is -0`)
    return
  }
  assert.equal(kind, 'object', `${path} is ${kind}, which JSON cannot carry`)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertLossless(item, `${path}[${index}]`)
    return
  }
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} is not a plain object`)
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} is undefined`)
    assertLossless(item, `${path}.${key}`)
  }
}

test('jsonSafe drops the properties that are undefined', () => {
  const safe = jsonSafe({ ok: true, lastClaim: undefined, lastError: undefined, points: 400 })
  assert.deepEqual(safe, { ok: true, points: 400 })
  assert.equal('lastClaim' in safe, false)
  assert.equal('lastError' in safe, false)
})

test('jsonSafe turns undefined array entries into null', () => {
  assert.deepEqual(jsonSafe([1, undefined, 3]), [1, null, 3])
})

test('jsonSafe replaces a number JSON cannot carry with null', () => {
  assert.deepEqual(jsonSafe({ a: Number.NaN, b: Infinity, c: 1.5 }), { a: null, b: null, c: 1.5 })
})

test('jsonSafe keeps null and the plain data it is given', () => {
  const panel = normalizePanel({
    scene: 3,
    days: [
      { day_no: 1, points: 400, bonus_points: 0, status: 3, is_today: false },
      { day_no: 2, points: 1000, bonus_points: 0, status: 2, is_today: true },
    ],
  })
  assert.deepEqual(jsonSafe(panel), panel)
  assertLossless(jsonSafe(panel), 'panel')
})

test('the status result of a fresh plugin is lossless', () => {
  // A plugin that has never claimed anything has no `lastClaim` and no
  // `lastError`; both used to be `undefined` and the tool call failed.
  const status = {
    ok: true,
    action: 'status',
    panel: normalizePanel({ scene: 3, days: [] }),
    token: { ok: true, source: 'miniMaxCode', expiresInMs: 1000, needsRefresh: false, refreshing: false },
    lastClaim: undefined,
    lastError: undefined,
  }
  const safe = jsonSafe(status)
  assertLossless(safe, 'status')
  assert.equal(safe.ok, true)
  assert.equal(safe.action, 'status')
})

test('a claim result without points is lossless', () => {
  const safe = jsonSafe({
    ok: true,
    action: 'claim',
    claimed: false,
    alreadyClaimed: true,
    dayNo: undefined,
    points: undefined,
    panel: undefined,
  })
  assertLossless(safe, 'claim')
  assert.equal(safe.alreadyClaimed, true)
})

test('the panel reads the streak that ends at today', () => {
  const panel = normalizePanel({
    scene: 3,
    days: [
      { day_no: 1, points: 400, status: 3, is_today: false },
      { day_no: 2, points: 400, status: 3, is_today: false },
      { day_no: 3, points: 1000, status: 3, is_today: true },
    ],
  })
  assert.equal(panel.streak, 3)
  assert.equal(panel.claimedToday, true)
  assert.equal(panel.claimableNow, false)
  assert.equal(panel.today?.dayNo, 3)
})

test('the day key and the hour wait follow the local clock', () => {
  assert.match(localDayKey(Date.UTC(2026, 0, 2, 3, 4)), /^\d{4}-\d{2}-\d{2}$/)
  const wait = millisUntilHour(9, Date.UTC(2026, 0, 2, 3, 4))
  assert.ok(wait > 0 && wait <= 24 * 3600 * 1000)
})

test('the OAuth endpoint follows the region', () => {
  assert.equal(oauthTokenURLFor('en'), 'https://account.minimax.io/oauth2/token')
  assert.equal(oauthTokenURLFor('cn'), 'https://account.minimax.cn/oauth2/token')
})

test('md5 matches the known digest of an empty string', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
})
