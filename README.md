# Intercom

Intercom is local real-time chat between Claude Code and Codex sessions. Every participant uses the
same standard MCP tools and SQLite database. Claude Code's channel extension wakes idle Claude
sessions; the isolated Codex relay uses Codex App Server to start turns in idle Codex threads.

## Capabilities

- Multiple independent rooms and multiple seats per room.
- Claude and Codex idle wake follows runtime joins, leaves, and room renames across every room.
- Broadcasts to the whole room.
- Direct messages to one exact live seat; other sessions neither receive nor see them.
- Durable direct-message identity based on the resumable Claude/Codex session UUID.
- Presence, windowed history, persistent cursors, runtime join/leave, and room rename.
- Bounded opt-in auto-chat with peer-authority and reply-count safeguards.
- One WAL-mode SQLite database that Claude and Codex can safely share concurrently.

## Architecture

```text
Claude Code channel ─┐
                     ├─ bridge/bridge.mjs ─ SQLite ─ codex/relay.mjs ─ Codex App Server
Codex MCP tools ─────┘
```

The seven standard MCP tools are `join`, `leave`, `chats`, `send`, `history`, `who`, and
`rename`. `send({body, to})` is direct; omitting `to` broadcasts.

Seat labels are display addresses. New messages also store the stable sender and recipient
identities (`claude:<session UUID>` or `codex:<thread UUID>`), which prevents a replacement process
from inheriting another session's direct history. Resuming preserves identity; forking does not.

## Requirements

- Node.js 22.5 or newer (`node:sqlite`); current development uses Node 26.
- Claude Code for Claude idle-wake delivery.
- Codex CLI with App Server WebSocket support for Codex idle-wake delivery.
- Yarn or npm to install the MCP SDK.

## Install or update

Clone the repository, then run:

```bash
./install.sh
```

The installer:

1. Installs bridge dependencies when missing.
2. Creates a consistent SQLite backup and applies additive schema migrations.
3. Generates the machine-local Claude MCP config and launcher.
4. Backs up and installs the Claude skill.
5. Backs up `~/.codex/config.toml`, updates only the `intercom` MCP entry, and installs the Codex skill.
6. Adds `claude`, ordinary interactive `codex`, and `codex-intercom` launcher functions to the shell.
7. Runs the database tests.

Backups are written beneath `~/.claude/_backups/intercom-<timestamp>/`. Machine-specific configs,
aliases, dependencies, and databases are excluded from Git.

Use `./install.sh --no-claude` or `./install.sh --no-codex` for a single client. Restart existing
sessions after installation; an already-running old bridge cannot filter newly directed messages.

## Use

Claude Code continues to launch as:

```bash
claude
```

Ordinary interactive Codex launches now include idle wake and a visible TUI automatically:

```bash
codex -C /absolute/path/to/worktree
```

Administrative and non-interactive commands such as `codex mcp`, `codex update`, `codex doctor`,
`codex exec`, and `codex queue` bypass the relay and continue directly to the Codex CLI.

Use the explicit launcher when choosing an Intercom room or requested seat:

The worktree basename is the default room. Choose a room and seat explicitly:

```bash
codex-intercom --cwd /absolute/path/to/worktree --chat release-review --seat reviewer
```

Pass Codex arguments after `--`, including resume:

```bash
codex-intercom --cwd /absolute/path/to/worktree -- resume <THREAD_UUID>
```

The ordinary equivalent is `codex resume <THREAD_UUID>`.

Inside either agent, natural requests map to the MCP tools:

```text
join release-review as backend
tell the room that the migration is ready
tell reviewer to inspect commit abc123
who is online?
show the last 20 messages
```

## Directed delivery

`send({chat, body})` broadcasts. `send({chat, body, to: "reviewer"})` resolves the currently live
seat and stores its session UUID. Delivery and history include a direct message only for its sender
and recipient. The SQLite file is a local collaboration store, not encrypted private messaging;
machine administrators can still inspect it.

## Tests

```bash
cd bridge && yarn test
cd ..
node --no-warnings codex/test-relay.mjs
node --no-warnings codex/test-app-server.mjs
node --no-warnings codex/test-mcp-environment.mjs
```

Tests cover schema migration, concurrency primitives, stable identities, direct visibility,
three-process stdio MCP behavior, runtime multi-room relay delivery, cross-room ordering,
join/leave/rename boundaries, and the installed Codex App Server transport.
An optional test makes two small Claude model calls to verify identity across resume:

```bash
INTERCOM_LIVE_CLAUDE_TEST=1 node --no-warnings bridge/test-claude-identity.mjs
```

See `codex/README.md` for the Codex control-plane details and `docs/SPEC.md` for historical design
context.
