<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-web-search</h1>
  <p><b>Web search for DeepSeek Harness through MiniMax — no DeepSeek balance needed.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-minimax-kit/releases"><img alt="release" src="https://img.shields.io/github/v/tag/borncode-app/dsh-minimax-kit/dsh-minimax-web-search?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="tool" src="https://img.shields.io/badge/tool-web_search_20250305-D97757?style=flat-square">
  </p>
</div>

---

## The problem

`web_search` in the Harness has two shipped routes, and both need a
DeepSeek credential:

- the DeepSeek Search API (`deepseek-search-api`), which is billed to the
  DeepSeek account, and
- the legacy Messages search (`deepseek-official`), which spends DeepSeek
  model tokens on every search.

With no DeepSeek balance, both fail with `HTTP 402 Insufficient Balance` and
the model is told to check its search endpoint — advice that does not help,
because the endpoint is fine and the balance is not.

MiniMax already serves the same native search tool on its own Anthropic
endpoint, under the Token Plan you already pay for.

## What it does

This plugin registers a **MiniMax-backed search provider** in `ctx.web`:

```
web search
   │
   ▼
dsh-minimax-web-search
   │
   ├─ POST https://api.minimax.io/anthropic/v1/messages
   │    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
   │    ← Token Plan key
   │
   └─ plan quota spent (HTTP 429 / 2056)
        └─ POST https://agent.minimax.io/mavis/api/v1/llm/v1/messages
             ← MiniMax Code OAuth grant, billed to credits
```

- **One request, one tool.** MiniMax runs the search on its servers and
  returns the answer and the sources together, so a search costs one model
  turn — not one turn plus a DeepSeek search call.
- **Sources with excerpts.** Every `web_search_tool_result` item carries
  `title`, `url`, `page_age`, and a short `content` excerpt, which this
  plugin maps onto the seam's `title` / `url` / `publishedAt` / `snippet`
  fields.
- **Credits when the plan is spent.** A refusal that names the Token Plan
  limit continues the same request on the MiniMax Code credit endpoint with
  the OAuth grant, the same way the credit proxy beside it does.
- **`pause_turn` handled.** MiniMax ends a turn when it reaches the tool
  limit; the provider continues the conversation, exactly as MiniMax's own
  documentation describes, until the model answers.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x |
| MiniMax | A Token Plan API key (`sk-cp-…`), or MiniMax Code signed in |
| Env | `MINIMAX_API_KEY` for the plan side |
| Peer | [`dsh-minimax-auth`](../dsh-minimax-auth) — the shared grant reader |

## Install

Install the `dsh-minimax-kit` bundle; this package ships inside it. To use it,
select **MiniMax** as the search provider on the **Plugins → Web search and
fetch** page, or set it in the profile patch:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: minimax-web-search
    fetchProvider: http
```

## Configuration

| field | default | meaning |
|---|---|---|
| `baseURL` | `https://api.minimax.io/anthropic` | Anthropic-compatible endpoint; `/v1/messages` is appended |
| `model` | `MiniMax-M3.1-Flash` | Model that answers the search |
| `apiVersion` | `2023-06-01` | `anthropic-version` header |
| `maxTokens` | `4096` | Upper bound on generated tokens per request |
| `maxUses` | `3` | `web_search` uses per request |
| `maxContinuations` | `4` | Continuation rounds after a `pause_turn` |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential reference for the plan key |
| `preferOfmGrant` | `true` | Read Our Free Model's MiniMax Code grant first |
| `creditBaseURL` | `https://agent.minimax.io/mavis/api/v1/llm/v1` | Credit endpoint |

## Things worth knowing

- **A search costs MiniMax tokens.** The Token Plan pays for the search turn
  until its quota is spent; after that the credit balance pays for it.
- **`MiniMax-M3.1-Flash` cannot disable thinking.** A request that sends
  `thinking: { type: 'disabled' }` is refused with error 2013, so this
  provider never sends that field.
- **The MiniMax Code sign-in is optional.** Without it the search still works
  while the Token Plan has quota; it is only needed for the credit fallback.
- **`maxUses` trades turns for sources.** MiniMax ends the turn at the tool
  limit, so a higher value costs a continuation round.

## License

[MIT](LICENSE) © 2026 BornCode
