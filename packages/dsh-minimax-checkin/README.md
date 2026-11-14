<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-checkin</h1>
  <p><b>Claims the MiniMax daily check-in reward from inside DeepSeek Harness.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-minimax-kit/releases"><img alt="release" src="https://img.shields.io/github/v/tag/borncode-app/dsh-minimax-kit/dsh-minimax-checkin?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="reward" src="https://img.shields.io/badge/reward-daily%20credits-8957e5?style=flat-square">
  </p>
</div>

---

## Where this code lives now

This plugin lives in **`dsh-minimax-kit`**, at `packages/dsh-minimax-checkin`:
[**github.com/borncode-app/dsh-minimax-kit**](https://github.com/borncode-app/dsh-minimax-kit).

The whole MiniMax set — the credit proxy, the check-in claim, the model-list
sync, the composer quota chip, the MiniMax Code bridge, and the shared grant
reader — is one repository with one install entry. Each part keeps its own
package, its own Config schema, and its own switch; only the repository is
shared. This package still owns the check-in client, the panel, the tool, and
the routes.

The MiniMax Code grant reader — reading `~/.minimax/auth`, refreshing it under
the app's own `auth.lock`, and the token/generation bookkeeping — lives next
door at `packages/dsh-minimax-auth`. This plugin and `dsh-minimax-credit`
both import it, so one refresh path writes the grant instead of two. The
dependency is a workspace link (`workspace:*`); bump the auth package's
version to roll it forward.

Nothing else moved: this repository still owns the check-in client, the request
signature, the panel, the tool, the routes, and the schedule. The `MinimaxAuth`
export remains here as a subclass that supplies this plugin's error class and
`MINIMAX_CHECKIN_*` codes.

## What it does

MiniMax Code shows a **Daily Check-in** card in its own account menu — seven days, 400 credits each, 1,000 on
the fourth and the seventh. The reward belongs to the account, not to the app, so there is no reason to open
MiniMax Code for it.

This plugin reads and presses the same reward through MiniMax's API:

- it borrows the sign-in MiniMax Code already stored on this machine (`~/.minimax/auth`),
- reads the panel from `GET /minimax-cloud/api/v1/signin/status`,
- claims it with `POST /minimax-cloud/api/v1/signin/claim`,
- and signs both requests with the same OAuth bearer, `x-timestamp`, `x-signature`, and `yy` headers the
  desktop client sends.

The credit lands in the same account, so the MiniMax route in the Harness keeps working with it.

## Features

- **A tool** — `minimax_daily_checkin` with `action: "status"` (read the panel) or `action: "claim"`.
- **A composer chip** — the current streak, the days left in this cycle, and a **Check in for N** button.
- **Two routes** — `GET /plugins/minimax-checkin/status` and `POST /plugins/minimax-checkin/claim`, on the
  Web GUI's own origin.
- **A daily schedule** — `autoCheckIn` claims at `autoCheckInHour` local time; the plugin skips the run when
  today's reward was already taken.
- **Never signs in on its own** — it reuses the grant MiniMax Code wrote, and refreshes it in place when it is
  about to expire, taking the same `auth.lock` the app uses so the two never fight over one token.
- **Honest failures** — a rejected sign-in, a second claim, and an unreachable service each get their own
  message instead of a generic error.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x (Web GUI) |
| Runtime | Node 24, supplied by the Harness runtime |
| MiniMax Code | Signed in on **this machine** — the plugin borrows that sign-in and never opens a browser |
| Account | MiniMax Code account (the reward belongs to it) |
| Peer | [`dsh-minimax-auth`](../dsh-minimax-auth) — the shared grant reader (a `link:` dependency, not a bundle) |

## Install

```bash
git clone https://github.com/borncode-app/dsh-minimax-kit.git dsh-minimax-kit
git clone https://github.com/borncode-app/dsh-minimax-kit/packages/dsh-minimax-auth.git dsh-minimax-auth
cd dsh-minimax-checkin && pnpm install
```

Then in DSH: **Plugins** → install the bundle from that directory, or:

```
plugin_manager install_bundle target=C:\path\to\dsh-minimax-checkin
```

Restart once. The chip appears next to the composer.

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | Registers the tool, the routes, and the schedule |
| `minimaxHome` | `''` | MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax` |
| `buildEnv` | `prod` | OAuth build environment directory under the MiniMax home |
| `region` | `en` | OAuth region directory under the MiniMax home |
| `apiBaseURL` | `https://agent.minimax.io` | Origin that serves the MiniMax Code API |
| `oauthTokenURL` | `''` | OAuth token endpoint; empty derives it from the region |
| `appVersion` | `3.1.14` | MiniMax Code version reported to the API |
| `refreshSkewMs` | `600000` | Refresh the OAuth token this long before it expires |
| `timeoutMs` | `20000` | Milliseconds one API request may take |
| `statusPath` | `/plugins/minimax-checkin/status` | Same-origin Web GUI path that reports the panel |
| `claimPath` | `/plugins/minimax-checkin/claim` | Same-origin Web GUI path that claims the reward |
| `autoCheckIn` | `false` | Claim the reward on a schedule |
| `autoCheckInHour` | `9` | Local hour of the day the scheduled claim runs |

> `appVersion` tells MiniMax which client the request claims to come from. If MiniMax Code updates and the API
> starts refusing the request, this is the first value to raise.

## How it works

```
tool call / composer chip / daily timer
              │
              ▼
     read the grant under ~/.minimax/auth  ──►  refresh in place when it is close to expiry
              │  (same auth.lock the app uses)
              ▼
   GET /minimax-cloud/api/v1/signin/status   ──►  the panel: days, points, streak
              │
              ▼
   POST /minimax-cloud/api/v1/signin/claim   ──►  day number and points granted
```

Both requests carry the OAuth bearer and the signature headers the desktop client sends, so the API sees the
same shape of request it sees from MiniMax Code.

## Files

| file | role |
|---|---|
| `index.js` | Host row: panel reading, claiming, the tool, the routes, the schedule; the grant reader comes from `dsh-minimax-auth` |
| `client.js` | the composer chip |
| `cordis.patch.yml` | the bundle patch that inserts the row |
| `locale/{en,th,zh}.json` | UI strings |
| `icon.svg` | plugin icon |
| `test/checkin.test.mjs` | the checks used while building it (no network) |
| `scripts/checkin-live.mjs` | a live call against the real API: `node scripts/checkin-live.mjs status` |
| `scripts/verify-tool.mjs` | runs the tool against the live API and passes the result through the Harness's own lossless-JSON validator |

## Limitations

- The account must already be signed in to MiniMax Code on this machine. A rejected refresh token needs
  MiniMax Code's own sign-in; the plugin does not open a browser.
- MiniMax allows one claim per day. A second claim returns `AlreadyClaimed` and grants nothing.
- The API group and its signature scheme are MiniMax's own; a future change to them can stop this plugin from
  reading the panel until it is updated.

## ภาษาไทย

Plugin นี้ **กดเครดิตรายวันให้อัตโนมัติ** โดยไม่ต้องเปิด MiniMax Code — กดให้ของขวัญชุดเดียวกับที่ MiniMax Code
แสดงในเมนูบัญชี (7 วัน, วันละ 400 เครดิต, วันที่ 4 และ 7 ได้ 1,000)

- ยืม **การ login ที่ MiniMax Code เก็บไว้** ใน `~/.minimax/auth` มาใช้ (ไม่ต้อง login ใหม่ ไม่เปิดเบราว์เซอร์)
- ต่อ API ของ MiniMax ด้วย header เดียวกับที่แอปเดสก์ท็อปส่ง (`x-timestamp`, `x-signature`, `yy`)
- มี **tool** `minimax_daily_checkin` (`action: "status" | "claim"`) และ **ป้ายใต้ช่องพิมพ์** ที่มีปุ่ม "Check in for N"
- ตั้ง `autoCheckIn: true` ให้กดของขวัญอัตโนมัติทุกวันเวลา `autoCheckInHour` (ปกติ 9 โมง) — ถ้ากดไปแล้ววันนั้นมันจะข้าม
- ตอน token ใกล้หมดอายุ มัน refresh เอง **ในไฟล์เดิมของ MiniMax Code** พร้อม lock เดียวกัน → ไม่แย่ง token กัน

⚠️ ข้อจำกัด: ต้องล็อกอิน MiniMax Code ไว้บนเครื่องนี้, MiniMax ให้กดได้วันละครั้ง (ครั้งที่สองได้ `AlreadyClaimed`),
และ `appVersion` ต้องตรงกับเวอร์ชัน MiniMax Code ที่ใช้อยู่ — ถ้าแอปอัปเดตแล้วเริ่มถูกปฏิเสธ ให้แก้ค่านี้ก่อน

## License

[MIT](LICENSE) © 2026 BornCode
