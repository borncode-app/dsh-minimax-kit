# dsh-minimax-auth

The MiniMax Code OAuth grant reader and refresher, shared by
[`dsh-minimax-credit`](../dsh-minimax-credit) and
[`dsh-minimax-checkin`](../dsh-minimax-checkin).

Not a bundle: it declares no `dsh.bundle.patch` and inserts no Loader row. It is
a plain library the two plugins import.

## Why it exists

Both plugins borrow the same grant MiniMax Code wrote under
`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`, and both refresh it
in place. While each carried its own copy, two implementations wrote that one
file: a refresh in one plugin could rotate the refresh token the other was about
to use, and the second refresh then failed with `invalid_grant` even though the
machine was still signed in.

One implementation, one code path, one place to fix.

## API

| export | what it does |
|---|---|
| `MinimaxCodeAuth` | reads the grant, refreshes it under MiniMax Code's own `auth.lock`, exposes `token()`, `peekToken()`, `status()`, `paths()` |
| `AuthError` | the default error class, used when a caller passes no `ErrorClass` |
| `AUTH_MESSAGES` | the user-facing wording, so both plugins say the same thing |
| `numberOf`, `readConfig` | small config helpers both plugins also use |
| `oauthAccountOrigin` | `account.minimax.cn` or `account.minimax.io` for a region |
| `withAuthLock`, `writePrivateFile` | the lock and private-write primitives, exported for callers with their own store |

A plugin keeps its own error class and code prefix:

```js
import { MinimaxCodeAuth } from '@local/dsh-minimax-auth'

export class WidgetUnavailableError extends Error { /* … */ }

class WidgetAuth extends MinimaxCodeAuth {
  constructor(options) {
    super({ ...options, ErrorClass: WidgetUnavailableError, codePrefix: 'MINIMAX_WIDGET_' })
  }
}
```

`token({ force: true })` refreshes even when the stored token still looks valid;
that is what a caller does after the API answers 401 for it.
