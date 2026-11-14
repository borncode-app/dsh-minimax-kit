import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_OFM_ACCOUNT, ofmAccessToken, ofmAuthPath, readOfmGrant } from '../ofm-auth.js'

/** A DSH home holding one Our Free Model account store. */
async function homeWith(store) {
  const root = await mkdtemp(join(tmpdir(), 'ofm-home-'))
  const dir = join(root, 'our-free-model', 'magpie', 'config', 'magpie')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'plugin-auth.json'), typeof store === 'string' ? store : JSON.stringify(store))
  return root
}

test('the store path sits under the Our Free Model home', () => {
  const path = ofmAuthPath({ ofmHome: 'C:\\dsh' })
  assert.ok(path.endsWith(join('our-free-model', 'magpie', 'config', 'magpie', 'plugin-auth.json')))
})

test('the global MiniMax Code channel is the default account', async () => {
  const home = await homeWith({
    [DEFAULT_OFM_ACCOUNT]: { access: 'mmoat_token', expires: Date.now() + 60000 },
  })
  try {
    const grant = await readOfmGrant({ ofmHome: home })
    assert.equal(grant.account, 'minimax-code-global')
    assert.equal(grant.accessToken, 'mmoat_token')
    assert.equal(grant.expired, false)
    assert.equal(await ofmAccessToken({ ofmHome: home }), 'mmoat_token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an expired grant is reported and not handed out', async () => {
  const home = await homeWith({
    [DEFAULT_OFM_ACCOUNT]: { access: 'mmoat_old', expires: Date.now() - 1000 },
  })
  try {
    const grant = await readOfmGrant({ ofmHome: home })
    assert.equal(grant.expired, true)
    assert.equal(await ofmAccessToken({ ofmHome: home }), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing, unreadable, or empty store yields nothing', async () => {
  const missing = await mkdtemp(join(tmpdir(), 'ofm-home-'))
  try {
    assert.equal(await readOfmGrant({ ofmHome: missing }), undefined)
    assert.equal(await ofmAccessToken({ ofmHome: missing }), undefined)
  } finally {
    await rm(missing, { recursive: true, force: true })
  }

  const broken = await homeWith('{ not json')
  try {
    assert.equal(await readOfmGrant({ ofmHome: broken }), undefined)
  } finally {
    await rm(broken, { recursive: true, force: true })
  }

  const empty = await homeWith({})
  try {
    assert.equal(await readOfmGrant({ ofmHome: empty }), undefined)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }

  const noToken = await homeWith({ [DEFAULT_OFM_ACCOUNT]: { expires: Date.now() + 1000 } })
  try {
    assert.equal(await readOfmGrant({ ofmHome: noToken }), undefined)
  } finally {
    await rm(noToken, { recursive: true, force: true })
  }
})

test('another account key can be read', async () => {
  const home = await homeWith({
    'minimax-code': { access: 'mmoat_cn', expires: Date.now() + 60000 },
  })
  try {
    const grant = await readOfmGrant({ ofmHome: home, ofmAccount: 'minimax-code' })
    assert.equal(grant.accessToken, 'mmoat_cn')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
