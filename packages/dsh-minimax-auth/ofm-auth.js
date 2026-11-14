/**
 * Read the MiniMax Code grant that Our Free Model already stores.
 *
 * Our Free Model (`dsh-our-free-model`) runs a MiniMax Code channel of its
 * own and keeps the signed-in grant in its Magpie config directory:
 *
 *   <dsh home>/our-free-model/magpie/config/magpie/plugin-auth.json
 *
 * The entry is keyed by the channel account id, and carries the OAuth access
 * token, the refresh token, and the expiry. It is the same MiniMax Code grant
 * the desktop app holds, reached through a different file.
 *
 * This reader never refreshes that grant: Our Free Model owns the refresh
 * cycle for its own channels, and a second refresher would rotate the refresh
 * token out from under it. It reads the token as it stands and reports when it
 * has expired, leaving the renewal to the owner.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The account key Our Free Model uses for the global MiniMax Code channel. */
export const DEFAULT_OFM_ACCOUNT = 'minimax-code-global'

/** The Harness home directory, the same resolution Our Free Model uses. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * The Our Free Model account store's path.
 *
 * @param options.ofmHome - Our Free Model home; empty means `$DSH_HOME` or `~/.dsh`.
 */
export function ofmAuthPath(options = {}) {
  const home = options.ofmHome === undefined || options.ofmHome.length === 0
    ? resolveDshHome()
    : resolve(options.ofmHome)
  return join(home, 'our-free-model', 'magpie', 'config', 'magpie', 'plugin-auth.json')
}

/**
 * One account's grant, read from Our Free Model's store.
 *
 * @param options.ofmHome - Our Free Model home; empty means `$DSH_HOME` or `~/.dsh`.
 * @param options.ofmAccount - The account key; defaults to the global MiniMax Code channel.
 * @returns the grant, or undefined when the file, the account, or the token is absent.
 */
export async function readOfmGrant(options = {}) {
  const account = options.ofmAccount === undefined || options.ofmAccount.length === 0
    ? DEFAULT_OFM_ACCOUNT
    : options.ofmAccount
  let text
  try {
    text = await readFile(ofmAuthPath(options), 'utf8')
  } catch {
    // Our Free Model may not be installed, or may not have signed in yet.
    return undefined
  }
  let store
  try {
    store = JSON.parse(text)
  } catch {
    return undefined
  }
  if (store === null || typeof store !== 'object') return undefined
  const entry = store[account]
  if (entry === null || typeof entry !== 'object') return undefined
  const access = typeof entry.access === 'string' ? entry.access : undefined
  if (access === undefined || access.length === 0) return undefined
  const expires = typeof entry.expires === 'number' && Number.isFinite(entry.expires) ? entry.expires : undefined
  return {
    account,
    accessToken: access,
    refreshToken: typeof entry.refresh === 'string' ? entry.refresh : undefined,
    expiresAtMs: expires,
    /** True when the grant is past its expiry and needs Our Free Model to renew it. */
    expired: expires !== undefined && expires <= Date.now(),
  }
}

/**
 * The access token Our Free Model holds, when it is still usable.
 *
 * @param options.ofmHome - Our Free Model home; empty means `$DSH_HOME` or `~/.dsh`.
 * @param options.ofmAccount - The account key; defaults to the global MiniMax Code channel.
 */
export async function ofmAccessToken(options = {}) {
  const grant = await readOfmGrant(options)
  if (grant === undefined) return undefined
  if (grant.expired === true) return undefined
  return grant.accessToken
}
