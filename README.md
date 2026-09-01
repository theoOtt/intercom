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
- Yarn Classic only when rebuilding the committed standalone plugin bundle from source.

## Marketplace install (recommended)

The repository is a private marketplace for both products. Authenticate GitHub on the machine,
then install the Codex plugin:

```bash
codex plugin marketplace add theoOtt/intercom
codex plugin add intercom@intercom
```

Install the Claude Code plugin from the same repository:

```bash
claude plugin marketplace add theoOtt/intercom
claude plugin install intercom@intercom --scope user
```

Plugin installation supplies the bundled MCP bridge and shared skill. Run the recoverable machine
setup once from either product so ordinary `claude` enables the channel and ordinary interactive
`codex` starts the idle-wake relay:

```text
# Start raw Codex once, then ask:
$intercom set up Intercom on this computer

# Or launch Claude once with the channel and run:
claude --dangerously-load-development-channels plugin:intercom@intercom
/intercom:setup
```

Intercom needs the development flag rather than `--channels`: Claude Code only registers
`--channels plugin:...` entries that are on Anthropic's approved channels allowlist (the official
Discord/Telegram/iMessage plugins). Anything else is skipped silently -- the MCP tools still work
but idle-wake never fires. The setup command writes the development flag into the `claude`
wrapper for the same reason; expect its confirmation dialog at startup.

Setup preserves the existing SQLite database, backs up and retires legacy standalone Intercom
skills/config, installs a stable runtime under `~/.local/share/intercom`, and sources
`~/.config/intercom/shell.zsh` from `.zshrc`. Open a new terminal after it finishes.

### Marketplace updates

```bash
codex plugin marketplace upgrade intercom
codex plugin add intercom@intercom

claude plugin marketplace update intercom
claude plugin update intercom@intercom
```

`claude plugin update` compares the manifest version, not the git commit, and reports "already at
the latest version" when it matches. Every change that should reach installed machines has to bump
the version, which lives in three files. Use the bump script so they stay in step:

```bash
cd bridge && yarn bump patch      # or minor, major, or an explicit x.y.z; add --dry-run to preview
```

After an update, run the setup skill/command once to refresh the pre-launch runtime, then start new
agent sessions.

## Legacy/manual install

The original clone installer remains available as a fallback:

```bash
git clone git@github.com:theoOtt/intercom.git ~/code/intercom
cd ~/code/intercom
./install.sh
```

It installs dependencies, backs up/migrates the database, configures MCP and standalone skills,
and adds shell launchers. Do not use the manual installer and marketplace bootstrap concurrently;
the marketplace setup safely retires a previous manual installation.

Backups are written beneath `~/.claude/_backups/intercom-<timestamp>/` or
`intercom-plugin-<timestamp>/`. Machine-specific configs, aliases, dependencies, and databases are
excluded from Git.

Restart existing sessions after installation; running sessions cannot adopt newly installed MCP,
skill, channel, or relay code.

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
cd bridge
corepack yarn@1.22.22 install
corepack yarn@1.22.22 test
corepack yarn@1.22.22 build:plugin
cd ..
node --no-warnings plugins/intercom/test-setup.mjs
INTERCOM_BRIDGE_PATH=plugins/intercom/dist/bridge.mjs \
  INTERCOM_TEST_DEFAULT_DB=1 node --no-warnings bridge/test-mcp.mjs
node --no-warnings codex/test-relay.mjs
node --no-warnings codex/test-app-server.mjs
node --no-warnings codex/test-mcp-environment.mjs
```

Tests cover schema migration, concurrency primitives, stable identities, direct visibility,
three-process stdio MCP behavior, runtime multi-room relay delivery, cross-room ordering,
join/leave/rename boundaries, and the installed Codex App Server transport.
An optional test makes two small Claude model calls through the installed marketplace channel to
verify identity across resume:

```bash
INTERCOM_LIVE_CLAUDE_TEST=1 INTERCOM_TEST_CLAUDE_PLUGIN=1 \
  node --no-warnings bridge/test-claude-identity.mjs
```

See `codex/README.md` for the Codex control-plane details and `docs/SPEC.md` for historical design
context.
