# mcpport

[![CI](https://github.com/Abdalkaderdev/mcpport/actions/workflows/ci.yml/badge.svg)](https://github.com/Abdalkaderdev/mcpport/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcpport)](https://www.npmjs.com/package/mcpport)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

List, lint, sync and convert MCP server configs across Claude Code, Codex, Gemini CLI and Cursor.

```sh
npx mcpport list
```

## Why

Every agent speaks MCP, and every agent stores its servers differently:

- Claude Code: JSON under `mcpServers`, `type` required for remote servers, `${VAR}` and `${VAR:-default}`
- Codex: TOML under `[mcp_servers.<name>]`, no string interpolation, secrets via `env_vars`, `bearer_token_env_var` and `env_http_headers`
- Gemini CLI: JSON, transport chosen by `command`, `httpUrl` (streamable HTTP) or `url` (SSE), `$VAR` in `env`
- Cursor: JSON, `${env:VAR}`

Add the same server to four agents by hand and you end up with four slightly different copies, a token pasted into a config file, and a command that only exists on one machine. mcpport reads all four, shows where they differ, flags what is broken, and copies servers between them with the syntax translated.

## Features

- One table of every MCP server across four agents, with drift marked
- Checks for broken JSON/TOML, duplicate keys, missing commands, plaintext secrets and unset variables
- Sync with a dry run by default, conflicts skipped, and a backup of the target file before every write
- Translates env var references, auth headers and transports between formats, and says what it had to drop
- Redacts env and header values, secret args and URL credentials in everything it prints
- Keeps comments and unrelated tables when writing Codex TOML, and unrelated keys when writing JSON
- JSON output and CI-friendly exit codes
- One runtime dependency ([smol-toml](https://github.com/squirrelchat/smol-toml))

## Quick start

```sh
npx mcpport list
npx mcpport lint
npx mcpport sync claude cursor
npx mcpport sync claude cursor --apply
```

## Commands

The output below is from a sample home with four user-scope servers and one local-scope server in Claude Code, three in Cursor, two in Codex and one in Gemini CLI.

### `list`

Every server, which agents have it, and whether the copies agree.

```
$ npx mcpport list
name      transport  target                                            claude codex  gemini cursor notes
context7  stdio      npx -y @upstash/context7-mcp                      -      yes    yes    -      differs: gemini
github    stdio      npx -y @modelcontextprotocol/server-github        yes    yes    -      yes    differs: codex, cursor
linear    http       https://mcp.linear.app/mcp                        yes    -      -      -
notion    http       https://mcp.notion.com/mcp                        -      -      -      yes
postgres  stdio      postgres-mcp --dsn postgres://app:***@localho...  yes    -      -      -
sentry    http       https://mcp.sentry.dev/mcp                        yes    -      -      yes
stripe    http       https://mcp.stripe.com                            local  -      -      -      claude:local /Users/you/work/shop

7 servers. claude: 4 + 1 local, codex: 2, gemini: 1, cursor: 3
```

Copies are compared after normalizing each format, so `${GITHUB_TOKEN}` in Claude Code and `${env:GITHUB_TOKEN}` in Cursor count as the same. `off` marks a Codex server with `enabled = false`. `local` marks a Claude Code local-scope server, shown on its own row with the directory it belongs to. Filter with `--agent <id>`, get redacted machine output with `--json`.

### `lint`

```
$ npx mcpport lint
warn   claude/github  references ${GITHUB_TOKEN}, which is not set
warn   claude/linear  plaintext secret in header "Authorization"; reference an environment variable instead
warn   claude/postgres  command "postgres-mcp" not found on PATH
warn   claude/postgres  plaintext secret in args; reference an environment variable instead
warn   claude/sentry  references ${SENTRY_TOKEN}, which is not set
warn   codex/github  references ${GITHUB_PERSONAL_ACCESS_TOKEN}, which is not set
error  gemini/context7  defined more than once in ~\.gemini\settings.json; only the last one is used
warn   cursor/github  references ${GITHUB_TOKEN}, which is not set
warn   cursor/sentry  references ${SENTRY_TOKEN}, which is not set

11 servers checked: 1 errors, 8 warnings
```

Errors:

- config file is not valid JSON or TOML, or `mcpServers` is not an object
- the same server name appears twice in one JSON file (the parser keeps the last one silently)
- an entry with neither `command` nor `url`, or an unknown `type`
- a Claude Code entry with `url` but no `type`, which Claude Code reads as stdio

Warnings:

- a stdio `command` that is not on `PATH` (or an absolute path that does not exist)
- a literal value in an auth-like header, env var, CLI flag (`--token`, `--api-key`, ...) or URL (`user:pass@`, `?api_key=`)
- a `${VAR}` reference without a default whose variable is not set in the current shell
- names in one agent that differ only by case

Issues in Claude Code local scope are labeled `claude:local <dir>`. Exits 1 when there are errors.

### `sync <from> <to>`

Copy servers one agent has and another doesn't.

```
$ npx mcpport sync claude cursor
conflict   github
new        linear
new        postgres
new        stripe  (from claude:local /Users/you/work/shop)

3 new, 0 overwrite, 1 conflicts (use --force), 0 invalid, 1 already in sync
Dry run. Re-run with --apply to write ~\.cursor\mcp.json.

$ npx mcpport sync claude cursor --apply
conflict   github
new        linear
new        postgres
new        stripe  (from claude:local /Users/you/work/shop)

3 new, 0 overwrite, 1 conflicts (use --force), 0 invalid, 1 already in sync
wrote ~\.cursor\mcp.json
backup ~\.cursor\mcp.json.2026-10-08T00-08-38-290Z.bak
```

- dry run unless `--apply`
- a server that exists in the target with a different definition is a conflict and is skipped unless `--force`
- entries that fail lint's structural checks are reported as `invalid` and never copied
- the target file is copied to `<file>.<timestamp>.bak` before it is written, and written through a temp file and rename
- a target that does not parse is never written
- Claude Code local-scope servers are read as a source, never written to

### `convert <server> --to <agent>`

Print one server in another agent's format, write it to a file, or merge it into that agent's config.

```
$ npx mcpport convert linear --to codex
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"

[mcp_servers.linear.http_headers]
Authorization = "Bearer ***"
note: from claude
note: secret values are redacted, use --out <file> or --apply to write them

$ npx mcpport convert github --to gemini --from cursor
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github@0.5.0"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
note: from cursor
note: secret values are redacted, use --out <file> or --apply to write them
```

```sh
npx mcpport convert sentry --to codex --out sentry.toml
npx mcpport convert sentry --to codex --apply
```

`--out` refuses to overwrite an existing file and `--apply` refuses to replace a different definition, both unless `--force`.

What gets translated:

| canonical (Claude Code)               | Codex                                   | Gemini CLI                | Cursor                     |
|---------------------------------------|-----------------------------------------|---------------------------|----------------------------|
| `"type": "http"`, `url`               | `url`                                   | `httpUrl`                 | `url`                      |
| `"type": "sse"`, `url`                | `url` (warns: no SSE in Codex)          | `url`                     | `url`                      |
| `env: { X: "${X}" }`                  | `env_vars = ["X"]`                      | `${X}`                    | `${env:X}`                 |
| `Authorization: "Bearer ${T}"`        | `bearer_token_env_var = "T"`            | same                      | `Bearer ${env:T}`          |
| header `"${V}"`                       | `env_http_headers = { H = "V" }`        | same                      | `${env:V}`                 |
| `${X:-default}`                       | `${X}` (warns)                          | `${X}` (warns)            | `${env:X}` (warns)         |

Keys an agent doesn't understand (`startup_timeout_sec`, `trust`, `envFile`, ...) are dropped and listed. Gemini CLI documents variable expansion only in `env`, so mcpport warns when a reference lands anywhere else.

## Agents

| id       | user config              | project config (`--project <dir>`) | servers key              |
|----------|--------------------------|------------------------------------|--------------------------|
| `claude` | `~/.claude.json`, plus local scope `projects["<dir>"].mcpServers` (read only) | `<dir>/.mcp.json`, plus `projects["<dir>"]` (read only) | `mcpServers` |
| `codex`  | `~/.codex/config.toml`   | `<dir>/.codex/config.toml`         | `[mcp_servers.<name>]`   |
| `gemini` | `~/.gemini/settings.json`| `<dir>/.gemini/settings.json`      | `mcpServers`             |
| `cursor` | `~/.cursor/mcp.json`     | `<dir>/.cursor/mcp.json`           | `mcpServers`             |

Formats follow each agent's docs: [Claude Code](https://code.claude.com/docs/en/mcp), [Codex](https://developers.openai.com/codex/mcp), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), [Cursor](https://cursor.com/docs/context/mcp).

## Install

Requires Node 22+.

```sh
npx mcpport <command>
npm i -g mcpport
```

## How it works

Each agent is a row in a table (`src/config.ts`) with its file path, format and a parser that turns its entries into one shape: transport, command, args, env, cwd, url, headers, with every variable reference rewritten to `${VAR}`. `list` and `lint` run on that shape. `sync` and `convert` render it back out through the target agent's renderer, which picks the right keys and reference syntax and records anything it could not carry over. JSON files are parsed and rewritten with other keys untouched. Codex TOML is edited as text: the old table and its subtables are cut out, the new one is appended, and the result is parsed again before anything is written.

## FAQ

**Does it modify anything without asking?**
No. `list`, `lint`, `convert` without `--apply`/`--out`, and `sync` without `--apply` are read-only. Every write backs up the existing file first.

**Will it print my tokens?**
No. Env and header values that are not pure variable references print as `***`, as do values after secret-looking flags, URL passwords and secret-looking query parameters. This applies to `--json` too. Only `--out` and `--apply` write real values, and only to disk.

**What does `claude:local <dir>` mean?**
`claude mcp add` defaults to local scope: the server is stored under `projects["<dir>"].mcpServers` in `~/.claude.json` and only loads in that directory. mcpport lists and lints these as their own rows. `sync` and `convert` can copy them out, but never write into local scope: Claude Code targets get the user scope (top-level `mcpServers`), or `.mcp.json` with `--project`.

**Can I move a local server to user scope?**
`mcpport convert <server> --from claude --to claude --apply`. The local entry stays where it is.

**The same local server name exists in several projects. Which one does `sync` copy?**
A user-scope server with that name wins. Otherwise, if every local copy is identical it is copied, and if they differ it is skipped and reported. With `--project <dir>` only that directory's local entries are read, and they take precedence over `.mcp.json`, matching Claude Code's order.

**Will it reformat my `~/.claude.json`?**
It is rewritten with 2-space indentation, which is how Claude Code writes it. Key order and every non-MCP key are kept. CRLF files stay CRLF.

**Why is a server I just synced shown as `differs`?**
Some definitions cannot be expressed in the target format, for example an env var in Codex that points at a variable with a different name, since Codex does not interpolate strings. The sync prints a warning for each of these.

## Roadmap

- pick one project's copy when a local-scope name differs between projects
- write to Claude Code local scope
- more agents: VS Code, Windsurf, Zed, Claude Desktop
- `diff <server>` between two agents' copies
- `lint --fix` to move plaintext secrets into env var references
- probe servers: start each one and report whether it answers `initialize`

## Contributing

Issues and PRs are welcome. For a new agent, link the page where it documents its config format.

```sh
git clone https://github.com/Abdalkaderdev/mcpport
cd mcpport
npm install
npm test
node src/bin.ts list
```

Tests run against a temporary home directory and never touch your real configs.

## License

[MIT](LICENSE)

## Author

Abdalkader Alhamoud · [abdalkader.dev](https://abdalkader.dev) · [@Abdalkaderdev](https://github.com/Abdalkaderdev)
