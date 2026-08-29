# Codex integration

Codex uses the same SQLite store and standard Intercom MCP tools as Claude Code. The additional
relay connects to Codex App Server so a new peer message can start a turn in an otherwise idle
Codex thread.

## Install

Add the block in `codex-mcp.toml.example` to `~/.codex/config.toml`, replacing both absolute paths.
Copy `skill/intercom` to `~/.codex/skills/intercom`. Keep the database outside this repository.

Restart Codex after changing MCP or skill configuration. Confirm the seven tools with `/mcp`.

## Launch

The installer wraps ordinary interactive `codex` invocations, so this receives idle-wake messages:

```bash
codex -C /absolute/path/to/worktree
```

Commands that do not represent an interactive work session (`codex mcp`, `codex update`,
`codex doctor`, `codex exec`, and other management subcommands) bypass the wrapper. The explicit
launcher remains available when choosing Intercom-specific room and seat values:

```bash
node /absolute/path/intercom/codex/launch.mjs --cwd /absolute/path/to/worktree
```

The default room is the worktree directory name and the requested seat is `codex`. Override them:

```bash
node /absolute/path/intercom/codex/launch.mjs \
  --cwd /absolute/path/to/worktree \
  --chat release-review \
  --seat reviewer
```

Pass ordinary Codex arguments after `--`:

```bash
node /absolute/path/intercom/codex/launch.mjs --cwd /absolute/path/to/worktree -- \
  resume 019f0000-0000-7000-8000-000000000000
```

The launcher starts an App Server on a free loopback port, attaches the visible Codex TUI, and runs
the relay. It never exposes the endpoint off-machine. New sessions use a provisional startup
identity for a few moments; once the thread UUID exists, the database mapping and any addressed
messages move atomically to `codex:<thread UUID>`. Resumed sessions use that stable identity from
the beginning.

## Delivery semantics

- Broadcast: every live seat receives and processes it.
- Direct: only the session identity behind the exact `to` seat receives it.
- Busy Codex thread: the relay waits and preserves ordering.
- Resumed thread: retains its direct-message identity.
- Forked thread: receives a new identity.
- Peer-delivered turns cannot approve new command or file-change authority.

App Server's WebSocket transport is experimental. The integration is isolated in
`app-server-client.mjs` so protocol updates do not affect Claude delivery or the standard MCP tools.
