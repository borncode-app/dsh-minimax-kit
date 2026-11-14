<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-credit</h1>
  <p><b>Keeps the MiniMax route alive after the Token Plan quota is spent — and shows the credits left.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-minimax-credit/releases"><img alt="release" src="https://img.shields.io/github/v/release/borncode-app/dsh-minimax-credit?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="wire" src="https://img.shields.io/badge/wire-Anthropic%20Messages-D97757?style=flat-square">
  </p>
</div>

---

## Where this code lives now

This plugin lives in **`dsh-minimax-kit`**, at `packages/dsh-minimax-credit`:
[**github.com/borncode-app/dsh-minimax-kit**](https://github.com/borncode-app/dsh-minimax-kit).

The whole MiniMax set — the credit proxy, the check-in claim, the model-list
sync, the composer quota chip, the MiniMax Code bridge, and the shared grant
reader — is one repository with one install entry. Each part keeps its own
package, its own Config schema, and its own switch; only the repository is
shared. This package still owns the proxy, the quota probe, the credit and
wallet reads, and the composer chip.

The MiniMax Code grant reader — reading `~/.minimax/auth`, refreshing it under
the app's own `auth.lock`, and the token/generation bookkeeping — lives next
door at `packages/dsh-minimax-auth`. This plugin and `dsh-minimax-checkin`
both import it, so one refresh path writes the grant instead of two. The
dependency is a workspace link (`workspace:*`); bump the auth package's
version to roll it forward.

The `TokenSource` export remains here as a subclass that supplies this
plugin's error class and `MINIMAX_CREDIT_*` codes.

## The problem

A MiniMax Token Plan API key (`sk-cp-…`) works against `https://api.minimax.io/anthropic` until the plan
quota runs out, and then it simply stops:

```json
HTTP 429
{"type":"error","error":{"type":"rate_limit_error",
 "message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"}}
```

Inside MiniMax Code the same moment is invisible, because that app calls the provider through its own proxy using
the account's OAuth grant (`mcode-public`) — a grant that is **billed to credits** once the plan is spent, on the
same Anthropic-Messages wire format. This plugin closes that gap for the Harness.

## What it does

It serves a **local Anthropic-Messages proxy** and points the `minimax-api` route at it:

1. forwards to the Token Plan endpoint while the plan has quota;
2. on a genuine plan-quota 429, retries the request against the MiniMax Code credit endpoint with the account's
   OAuth token — automatically, no model switch, no new session;
3. falls back to the plan the moment its quota comes back;
4. reads and shows the **remaining credits** of the account as a chip on the composer.

## Features

- **Transparent failover** — requests are relayed byte for byte (SSE, `tool_use`, `thinking`, image `tool_result`
  included); nothing in the payload is rewritten.
- **Plan → credits → plan** — no restart, no config flip; the direction is decided per request.
- **Credits chip** — the real balance from the account's membership record (`op_credit_summary`), not the Token
  Plan credit pool. Yellow when the plan is spent or credits are 0; red when the grant cannot be used.
- **Reuses MiniMax Code's grant in place** — reads `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`,
  refreshes it with the same OAuth flow app uses, and writes the new grant back in the app's own format
  (bumping `generation`, taking the same lock file) so DSH and MiniMax Code never fight over one token.
- **Status route** — `GET /plugins/minimax-credit/status` (and `GET :45677/status`) reports `mode`, `plan.percent`,
  `credits.remaining`, `credits.wallet`, `token.ok`, and request counters.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x |
| Runtime | Node 24, supplied by the Harness runtime |
| MiniMax Code | Signed in on the **same machine** — the credit fallback has no other token source |
| Env | `MINIMAX_API_KEY` for the plan side |
| Port | `45677` free (configurable) |
| Peer | [`dsh-minimax-auth`](../dsh-minimax-auth) — the shared grant reader (a `link:` dependency, not a bundle) |

## Install

```bash
git clone https://github.com/borncode-app/dsh-minimax-credit.git dsh-minimax-credit
git clone https://github.com/borncode-app/dsh-minimax-auth.git dsh-minimax-auth
cd dsh-minimax-credit && pnpm install
```

Then:

```
plugin_manager install_bundle target=C:\path\to\dsh-minimax-credit
```

Finally point the route at the proxy — in your profile's `cordis.patch.yml`, the `llm-pi-ai` entry:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      minimax-api:
        apiKeyEnv: MINIMAX_API_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:45677/anthropic   # was https://api.minimax.io/anthropic
        # models: … unchanged
```

Restart once. A route's `baseURL` must be a literal origin, which is exactly why the proxy lives on loopback.

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` = plain proxy with no credit fallback |
| `listenHost` / `listenPort` | `127.0.0.1` / `45677` | Where the proxy listens — must match `baseURL` |
| `minimaxHome` | `''` | Empty selects `$MINIMAX_HOME`, else `~/.minimax` |
| `buildEnv` / `region` | `prod` / `en` | Locates the OAuth files under `~/.minimax/auth/…` |
| `oauthTokenURL` | `''` | Empty selects `https://account.minimax.io/oauth2/token` (`cn` uses `.cn`) |
| `planBaseURL` | `https://api.minimax.io/anthropic` | Token Plan upstream |
| `creditBaseURL` | `https://agent.minimax.io/mavis/api/v1/llm/v1` | MiniMax Code credit upstream |
| `quotaURL` | `…/coding_plan/remains` | Where plan quota is read |
| `creditURL` | `…/token_plan_credit` | Fallback-switch / Token Plan credit pool |
| `membershipURL` | `…/commerce/get_membership_info` | Where credits remaining are read |
| `walletURL` | `…/account/query_balance` | Wallet balance |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential ref used for the plan side |
| `quotaCacheMs` / `creditsCacheMs` | `60000` | Cache lifetimes for the two probes |
| `refreshSkewMs` | `600000` | Refresh the OAuth grant this far ahead of expiry |

## How it works

```
llm-pi-ai route "minimax-api"  (baseURL → 127.0.0.1:45677/anthropic)
                  │
                  ▼
        dsh-minimax-credit proxy
          ├─ read plan quota (cached 60 s)
          ├─ plan has quota ──▶ api.minimax.io/anthropic        (API key)
          └─ plan spent     ──▶ agent.minimax.io/mavis/…/llm/v1 (OAuth grant)
                  │
                  ▼
        credits chip ── membership endpoint ── op_credit_summary
```

## Things worth knowing

- **Credits have a price.** When fallback runs, every turn is billed to your credit balance.
- **MiniMax Code must be signed in on the same machine.** No grant, no fallback — the chip turns red and says so.
- **The balance can lag.** The membership endpoint caches on their side; do not use the number for real-time billing
  decisions.
- **The proxy has no auth of its own.** It binds loopback only. Do not expose the port.

## Files

| file | role |
|---|---|
| `index.js` | proxy, quota probe, credit/wallet reads, status route; the grant reader comes from `dsh-minimax-auth` |
| `client.js` | the credits chip |
| `cordis.patch.yml` | the bundle patch with the row and its defaults |
| `locale/{en,th,zh}.json` | UI strings |
| `icon.svg` | plugin icon |
| `test-proxy.mjs` | offline suite (14 cases: decision, fallback, 401, stream, status, credits) |
| `test-live.mjs`, `test-refresh.mjs` | live checks against the real endpoints (not shipped to npm) |

## ภาษาไทย

Token Plan หมดแล้ว route `minimax-api` ของ DSH จะตายทันที (429) แต่ในแอป MiniMax Code ไม่ตาย เพราะมันยิงผ่าน
proxy ของตัวเองด้วย OAuth grant (`mcode-public`) ที่**หักเป็นเครดิต**ได้ Plugin นี้ทำแบบเดียวกันให้ DSH:

- เปิด proxy แบบ Anthropic-Messages บน `127.0.0.1:45677` แล้วชี้ `baseURL` ของ route มาที่นี่
- โควตายังมี → ส่งต่อไป Token Plan; เจอ 429 เพราะโควตาหมด → ส่งต่อไป credit endpoint ด้วย OAuth token ของแอป
- โควตากลับมา → กลับไปใช้ Token Plan เองอัตโนมัติ (ไม่ต้องสลับโมเดล/เริ่ม session ใหม่)
- มีป้าย **"เครดิต N"** ใต้ช่องพิมพ์ (ตัวเลขจริงจาก `op_credit_summary` ตรงกับหน้า Usage ของ MiniMax Code)
- อ่าน/ต่ออายุ token ของ MiniMax Code ในไฟล์เดิม พร้อม lock/generation เหมือนแอป → ไม่แย่ง token กัน

⚠️ เครดิตมีมูลค่า — เมื่อ fallback ทำงาน ทุกเทิร์นจะถูกหักเงินจริง, ต้องมี MiniMax Code ล็อกอินบนเครื่องเดียวกัน,
และ proxy ไม่มี auth ของตัวเอง (ผูก loopback เท่านั้น)

## License

[MIT](LICENSE) © 2026 BornCode
