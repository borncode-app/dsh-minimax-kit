# dsh-minimax-kit

The whole MiniMax set for DeepSeek Harness, in **one repository** and **one
Plugins entry**. Installing this bundle is enough — it carries its own packages.

The six parts keep their own code, their own Config schema, and their own
switch. Only the repository is shared.

| what stays separate | why |
|---|---|
| the credit proxy (port 45677), the check-in claim, the model-list sync, the MiniMax Code bridge, the quota chip, the web-search provider | one crashing row does not take the others down |
| one Config schema per row | the Plugins settings form stays short, and a bad field blocks only its own row |
| one package per row | `git pull` and a code review stay scoped to the part you touched |

## Layout

```
dsh-minimax-kit/            the bundle: cordis.patch.yml, locale, docs, icon
packages/
  dsh-minimax-auth/         shared grant reader (a library, not a row)
  dsh-minimax-credit/       the proxy, the quota probe, the composer chip
  dsh-minimax-checkin/      the daily claim, the panel, the tool, the routes
  dsh-minimax-model-sync/   the route's model list
  dsh-minimax-web-search/   web search through MiniMax's native web_search
  dsh-model-quota/          the composer quota chip (five quota sources)
  dsh-minimax-bridge/       the skills bridge and the agent presets
```

`packages/dsh-minimax-auth` is a plain library: it declares no
`dsh.bundle.patch` and inserts no Loader row. `dsh-minimax-credit`,
`dsh-minimax-checkin` and `dsh-model-quota` import it through a `link:` to the
sibling package, so one refresh path writes the MiniMax Code grant instead of
two.

## What it inserts

| row | package | what it does |
|---|---|---|
| `minimax-credit` | `packages/dsh-minimax-credit` | local Anthropic-Messages proxy that fails over to MiniMax credits after the plan quota is spent, plus the composer chip |
| `minimax-checkin` | `packages/dsh-minimax-checkin` | daily check-in claim, composer chip, `minimax_daily_checkin` tool |
| `minimax-model-sync` | `packages/dsh-minimax-model-sync` | keeps the `llm-pi-ai` `minimax-api` route's model list current |
| `minimax-web-search` | `packages/dsh-minimax-web-search` | web search through MiniMax's native `web_search` server tool, with a credit failover |
| `model-quota` | `packages/dsh-model-quota` | composer quota chip (`minimax-coding-plan` probe uses the same endpoint as credit), off when the selected provider is not MiniMax |
| `minimax-bridge` | `packages/dsh-minimax-bridge` | serves `~/.minimax` skills in place |
| `minimax-agent-bridge` | `packages/dsh-minimax-bridge/agents.js` | publishes the same home's agents as presets |
| `minimax-mcp-rea`, `minimax-mcp-photocraft`, `minimax-mcp-reverse` | `@deepseek-ai/dsh-mcp-client` | MiniMax Code's MCP servers, **shipped disabled** |

## Which credential it reads

`preferOfmGrant` is on by default. The plugins read the MiniMax Code grant
**Our Free Model** stores first:

```
<dsh home>/our-free-model/magpie/config/magpie/plugin-auth.json
```

When Our Free Model drives the MiniMax Code channel, that grant is the account
the quota, credit, and check-in endpoints answer for. It is read as it stands
and never refreshed here — Our Free Model owns the refresh cycle for its own
channel, and a second refresher would rotate the refresh token out from under
it.

The fallback is the credential reference in `apiKeyEnv` (`MINIMAX_API_KEY` by
default), which is the plain Token Plan account. The MiniMax Code desktop grant
under `~/.minimax/auth` is the fallback for the credit and check-in routes, and
this bundle refreshes that one itself.

Turn `preferOfmGrant` off to read the API key first.

### Models served through Our Free Model

When the selected model is served by **Our Free Model** (provider
`our-free-model`), the `model-quota` row uses the `ofm-gateway` source, which
needs no login and no direct Claude token:

- **Claude** (`claude/...`): one one-token message goes through Our Free Model's
  local engine gateway, and the `anthropic-ratelimit-unified-5h/7d` headers the
  gateway passes through give the 5-hour and weekly windows. The result is cached
  for `cacheSeconds` (300 by default), so it costs one token per five minutes.
- **MiniMax** (`minimax/...`): reads the plan quota with the key named by
  `minimaxFallback` (the `minimax-api` entry, `MINIMAX_API_KEY`).

The gateway is found beside Our Free Model's `owner.lock`; set `gatewayURL` to
pin it. Nothing in Our Free Model is modified. A caller that names only the
provider (for example BornCode's `auto-continue`) gets the model that provider
last served.

`minimax-credit` and `minimax-model-sync` still talk to MiniMax directly with
the API key; only the quota chip goes through Our Free Model.

## Install

1. Install this bundle.
2. Nothing else. The bundle carries its packages as dependencies, so each
   row resolves by the package's own name and keeps its title, icon, and
   Config schema.

If the five standalone packages are also installed, turn them off in
**Plugins** — otherwise their rows appear twice.

## Develop

```bash
pnpm install          # links the workspace packages
pnpm -r test          # auth 12, checkin 10, credit 15, bridge render
```

Each package keeps its own suite: `node --test` in `packages/dsh-minimax-auth`
and `packages/dsh-minimax-checkin`, `node test-proxy.mjs` in
`packages/dsh-minimax-credit`, `node test-render.mjs` in
`packages/dsh-minimax-bridge`.

## Configure once

`minimaxHome`, `buildEnv`, `region`, `apiKeyEnv` and the two cache windows live in
this bundle's `cordis.patch.yml`, so they change in one place instead of five.
A row-level edit in **Plugins** writes to the profile patch, which overrides this
bundle; keep a value here in sync if you want it to survive a reinstall.

The credit proxy's origin is fixed at `http://127.0.0.1:45677/anthropic`; that is
the `baseURL` the profile's `llm-pi-ai` `minimax-api` route must name.

## Turn one part off

Individual rows stay addressable. In **Plugins**, disable the row you do not
want, for example `minimax-checkin` for a week away, or `minimax-model-sync` when
you manage the model list by hand. The rest keep running.

## Limitations

- Changing `minimaxHome`, `buildEnv` or `region` here does not migrate tokens
  already refreshed under the old namespace.
- The three MCP rows carry absolute Windows paths from the machine this bundle was
  written on; edit them for another machine. `rea` publishes 229 tools and
  `mcp-reverse` 111, which is why they ship disabled.
- The Our Free Model grant is never refreshed here. When Our Free Model renews
  it, the plugins pick the new token up on their next read; an expired one is
  skipped, and the API key answers instead.
- `minimax-checkin` still needs the MiniMax Code grant: Our Free Model has no
  check-in endpoint.
- The MiniMax quota shown for an Our Free Model model is the API-key account's.
  If that is a different account from the one Our Free Model's MiniMax channel
  spends, the numbers will not match.

## License

MIT — see [LICENSE](LICENSE).
