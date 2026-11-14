# dsh-minimax-kit

One Plugins entry for the five MiniMax bundles, without merging their code.

| what stays separate | why |
|---|---|
| the credit proxy (port 45677), the check-in claim, the model-list sync, the MiniMax Code bridge, the quota chip | one crashing row does not take the others down |
| one Config schema per row | the Plugins settings form stays short, and a bad field blocks only its own row |
| four upstream repositories | `git pull` keeps working on each of them |

## What it inserts

| row | package | what it does |
|---|---|---|
| `minimax-credit` | `@local/dsh-minimax-credit` | local Anthropic-Messages proxy that fails over to MiniMax credits after the plan quota is spent, plus the composer chip |
| `minimax-checkin` | `@local/dsh-minimax-checkin` | daily check-in claim, composer chip, `minimax_daily_checkin` tool |
| `minimax-model-sync` | `@local/dsh-minimax-model-sync` | keeps the `llm-pi-ai` `minimax-api` route's model list current |
| `model-quota` | `@local/dsh-model-quota` | composer quota chip (`minimax-coding-plan` probe uses the same endpoint as credit), off when the selected provider is not MiniMax |
| `minimax-bridge` | `@local/dsh-minimax-bridge` | serves `~/.minimax` skills in place |
| `minimax-agent-bridge` | `@local/dsh-minimax-bridge/agents` | publishes the same home's agents as presets |
| `minimax-mcp-rea`, `minimax-mcp-photocraft`, `minimax-mcp-reverse` | `@deepseek-ai/dsh-mcp-client` | MiniMax Code's MCP servers, **shipped disabled** |

## Install

The five packages must stay installed in the profile, because the rows resolve
them from there; this bundle ships no code of its own.

1. Install this bundle.
2. In **Plugins**, turn off `@local/dsh-minimax-credit`, `@local/dsh-minimax-bridge`,
   `@local/dsh-minimax-model-sync`, `@local/dsh-minimax-checkin` and `@local/dsh-model-quota`.

Turning those off deselects their layers and keeps their dependencies, so the rows
above still start. Leaving them on registers every row twice.

## Configure once

`minimaxHome`, `buildEnv`, `region`, `apiKeyEnv` and the two cache windows live in
this bundle's `cordis.patch.yml`, so they change in one place instead of five.
A row-level edit in **Plugins** writes to the profile patch, which overrides this
bundle; keep a value here in sync if you want it to survive a reinstall.

The credit proxy's origin is fixed at `http://127.0.0.1:45677/anthropic`; that is
the `baseURL` the profile's `llm-pi-ai` `minimax-api` route must name.

## Turn one part off

Individual rows stay addressable. In **Plugins**, disable the row you do not want
for example `minimax-checkin` for a week away, or `minimax-model-sync` when you
hand-manage the model list — and the rest keep running.

## Limitations

- This bundle declares no dependency on the five packages. Uninstalling one of
  them leaves its row unable to start until you reinstall it or disable the row.
- Changing `minimaxHome`, `buildEnv` or `region` here does not migrate tokens
  already refreshed under the old namespace.
- The three MCP rows carry absolute Windows paths from the machine this bundle was
  written on; edit them for another machine. `rea` publishes 229 tools and
  `mcp-reverse` 111, which is why they ship disabled.
