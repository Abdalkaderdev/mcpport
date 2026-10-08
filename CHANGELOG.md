# Changelog

## 0.1.1

- redact secrets in `NAME=value` and `Header: value` args (`docker run -e`, `mcp-remote --header`), after `--key`, and in nested keys like `oauth.clientSecret`; lint flags them as plaintext
- `--help` prints usage instead of running the command
- JSON configs with comments are read; writing to one is refused instead of dropping the comments
- writes go through symlinked config files instead of replacing the link, and keep the file's permissions

## 0.1.0

- `list`, `lint`, `sync`, `convert` for MCP servers in Claude Code, Codex, Gemini CLI and Cursor
- user configs by default, project configs with `--project <dir>`
- Claude Code local scope (`projects[<dir>].mcpServers`) is listed, linted and usable as a sync source, never written
- backups before every write, redacted output
