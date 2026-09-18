# opencode2-subscription-quota-plugin

Show provider subscription quota inside the OpenCode 2 TUI: a sidebar panel that
refreshes itself, plus `/quota` and `/quota_diag`.

```text
Quota
Claude 5h  ██░░░░░░  24% 18:20
Claude 7d  ███░░░░░  43% Tue 08:00
Codex 7d   ░░░░░░░░   0% Sat 13:30
```

Each row is remaining quota, then the local wall-clock time of the next reset.
The reset column widens only as far as it has to: `18:20` today, `Tue 08:00`
within a week, `09-30 19:00` beyond that.

## Why this exists

[`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) is an
OpenCode 1 plugin. Release 4.10.0 still peer-depends on `@opencode-ai/plugin`
and fails to load in OpenCode 2 as a TUI plugin. Upstream V2 support is tracked
in [issue #229](https://github.com/slkiser/opencode-quota/issues/229) and
[PR #196](https://github.com/slkiser/opencode-quota/pull/196), both open at the
time of writing.

Its *CLI* works fine, so this plugin keeps upstream as the data source and only
re-implements the presentation layer for OpenCode 2.

## Requirements

- OpenCode 2. Developed against `v0.0.0-beta-19425`; the plugin API is still in
  beta and later builds may need adjustments.
- The upstream CLI on `PATH`: `npm install -g @slkiser/opencode-quota`.
- Node.js 22.13 or newer, and only for the optional credential mirror described
  below. That is the first version where `node:sqlite` works without
  `--experimental-sqlite`. Everything else works without Node on `PATH`.

## Install

Clone the repository and point OpenCode at the checkout:

```sh
git clone https://github.com/walotta/opencode2-subscription-quota-plugin.git
```

```jsonc
// opencode.jsonc
{
  "plugins": ["/path/to/opencode2-subscription-quota-plugin"]
}
```

Update it with `git pull`.

> [!NOTE]
> `opencode2 plugin add github:walotta/opencode2-subscription-quota-plugin`
> installs the package and the server half loads, but on `v0.0.0-beta-19425` the
> CLI never loads the TUI half of a Git-sourced package: the sidebar and both
> commands are missing, with nothing in the log. A path that points inside the npm
> cache's `node_modules` behaves the same way. Until that is fixed upstream, a
> directory path is the form that works.

The package exports both a server entrypoint (`.`) and a TUI entrypoint
(`./tui`), so this single entry loads both halves.

## Configuration

The sidebar and the commands run in the CLI process, and only `cli.json` options
reach it. Options attached to an `opencode.json(c)` entry configure the server
half, which ignores them:

```jsonc
// cli.json
{
  "plugins": [
    {
      "package": "/path/to/opencode2-subscription-quota-plugin",
      "options": {
        "sidebar": { "anthropic": "Claude", "openai": "Codex" },
        "sync": true
      }
    }
  ]
}
```

Use the same path in both files. The CLI still loads the TUI half once, and the
`cli.json` options apply.

| Option | Default | Effect |
| --- | --- | --- |
| `sidebar` | every provider that reports a percentage | Object of `providerID` to sidebar label. Only the listed providers are shown, in the order given, and one that reports nothing still gets a `no data` row. |
| `watch` | `{ "anthropic": "Claude", "openai": "Codex" }` | Providers that `/quota` always accounts for. A watched provider that returns nothing is listed as `no data`, so a broken credential looks different from an unconfigured provider. |
| `binary` | unset | Absolute path to `opencode-quota`, tried before the one on `PATH`. Useful when the TUI inherits a `PATH` without the npm global bin directory. |
| `sync` | `true` | Mirror OpenCode 2 credentials into `auth.json` before reading quota or running `/quota_diag`. See below. |

Providers whose quota is not a percentage, such as Copilot's
`quota details unavailable`, have nothing to plot and appear only in `/quota`.

## Commands

| Command | Effect |
| --- | --- |
| `/quota` | Dialog with every reporting provider, plus the watched providers that returned nothing. |
| `/quota_diag` | Upstream `opencode-quota status` output, prefixed with the result of the credential mirror. Use it when a provider shows `no data`. |

Both are also in the command palette under the "Quota" group.

## Credential mirror

> [!IMPORTANT]
> With `sync` enabled, which is the default, this plugin copies OAuth tokens
> between two credential stores on your machine. Read this section before
> installing it.

OpenCode 2 keeps credentials in the `credential` table of `opencode.db`. The
upstream CLI predates that and reads only the OpenCode 1 store,
`~/.local/share/opencode/auth.json`, so after `opencode2 auth login` it keeps
using whatever stale token `auth.json` holds and reports `Token expired`.

[`sync-auth.mjs`](./sync-auth.mjs) closes that gap. It is a standalone script,
about 130 lines, so it can be audited and run by hand:

```sh
node sync-auth.mjs            # openai only, the default
node sync-auth.mjs openai anthropic
```

What it does:

- reads the *active* credential for the named providers from `opencode.db`,
  opened read-only;
- writes `type`, `refresh`, `access`, `expires` and the account id into
  `auth.json`, but only when the OpenCode 2 token expires later than the one
  already there, so a fresher OpenCode 1 login is never clobbered;
- leaves every other entry in `auth.json` byte-for-byte alone, and creates the
  file owner-readable only (`0600`) if it does not exist;
- writes atomically through a temporary file.

`anthropic` is not a default because the upstream CLI resolves Claude quota
through its own credential fallback chain, and other plugins may own that
`auth.json` entry. Pass it explicitly if you want it mirrored.

Set `"sync": false` to disable the mirror completely. Quota for providers that
still authenticate through `auth.json` may then read as expired.

## How it works

1. `opencode-quota show` performs the live provider fetch and rewrites upstream's
   shared cache.
2. `opencode-quota show --json` reads that cache without making extra provider
   requests, which is what this plugin parses.

Both calls happen in that order on every refresh, because `--json` alone would
return data as stale as the last run. The sidebar refreshes every five minutes;
upstream keeps its own TTL, so polling faster mostly re-reads the same numbers.
`/quota` notes the cache age when it exceeds 15 minutes.

All of this runs in the CLI process. The server entrypoint exists only so
OpenCode discovers the package as a plugin with both halves.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `opencode-quota not found` | The CLI is not on the `PATH` the TUI inherited. Install it globally or set `options.binary`. |
| A provider shows `no data` | Run `/quota_diag`. Upstream reports there whether the provider is configured and why it returned nothing. |
| `Token expired` after logging in | The upstream CLI read a stale `auth.json`. Check the `credential sync:` line at the top of `/quota_diag`, and confirm `node` is on `PATH`. |
| Sidebar rows are missing | Only percentage windows are plotted. Check `/quota` for value-only providers. |
| Long provider names truncated | Providers without a built-in short label use their provider id, trimmed to the column. Give them names with `options.sidebar`. |

## Credits

Quota data comes entirely from
[`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) (MIT).
This plugin only shells out to that CLI and renders its output; it contains no
upstream code.

## License

MIT
