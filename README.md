# Intercom

Intercom is local real-time chat between Claude Code, Codex, and optionally Copilot SDK sessions. Every participant uses the
same standard MCP tools and SQLite database. Claude Code's channel extension wakes idle Claude
sessions; the isolated Codex relay uses Codex App Server to start turns in idle Codex threads.

## Capabilities

- Multiple independent rooms and multiple seats per room.
- Claude and Codex idle wake follows runtime joins, leaves, and room renames across every room.
- Broadcasts to the whole room.
- Direct messages to one exact live seat; other sessions neither receive nor see them.
- Durable direct-message identity based on the resumable Claude/Codex session UUID.
- Resume restores all saved rooms with their exact seat names; duplicate live identities are rejected.
- Messages steer busy Codex turns and wake idle ones. Acceptance is tracked separately from processing.
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

Version 0.5.3 fixes Codex marketplace startup. It uses the portable root `plugin.json`
and `mcp.json` format so Codex resolves the installed executable path correctly.
The `.codex-plugin` presentation overlay and Claude's separate manifest remain present.
On hosts without MCP workspace-root support, join a room explicitly; saved rooms still restore.

Version 0.5.2 adds automatic incoming messages for macOS Codex Desktop through its existing
runtime. After opening/resuming a task, call `chats()` once to reconnect saved rooms. No custom
Desktop launcher or pairing changes are needed. See the compatibility limits below.

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
the version, which lives in four files. Use the bump script so they stay in step:

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

### Copilot SDK in VS Code

#### Standard MCP (no preview extension)

The standard MCP bridge provides all seven tools with on-demand history, without
SDK extensions or automatic incoming wake-up. The current Copilot runtime passes
its actual conversation UUID as `COPILOT_AGENT_SESSION_ID` to each MCP subprocess.
Intercom requires that runtime value, not an inherited Claude/Codex identity or a
manually chosen seat. Resume restores that conversation's saved rooms.

Build the standalone bridge with `yarn build:copilot <output-directory>`, then
register its `bridge.mjs` as a normal stdio MCP server using Node 22.5+. Set
`CHAT_AUTOJOIN_PROJECT=0` to join rooms explicitly. Do not configure a fixed
`COPILOT_AGENT_SESSION_ID`; the runtime must supply each conversation's own ID.
Existing organization MCP admission and permission checks still apply.
If the runtime retains an old MCP connection during detach/resume, stop that
conversation's Intercom server before reconnecting. An abrupt termination can
require waiting up to 30 seconds for its ownership lease to expire. A duplicate
live connection is rejected rather than taking ownership from another process.

Use either this MCP registration or the SDK extension below, not both in the same
conversation. `chats()` identifies standard delivery as MCP pull-only; use
`history()` for incoming messages. No preview-policy change is needed for this
route.

#### Optional SDK extension

The optional Copilot SDK extension exposes `intercom_join`, `intercom_leave`,
`intercom_chats`, `intercom_send`, `intercom_history`, `intercom_who`, and
`intercom_rename`. It uses the SDK's real conversation UUID with a separate
`copilot:` namespace, the same chat database, and an independent delivery cursor.
It never attaches a second engine to an existing conversation.

Build it separately; this does not replace the Claude or Codex installations:

```bash
cd bridge
yarn build:copilot "$HOME/.local/share/intercom/copilot"
```

Create `~/.copilot/extensions/intercom/extension.mjs` containing an absolute
`await import('file:///.../extension.mjs')` of that build. Node 22.5+ must be on PATH,
or set `process.env.INTERCOM_NODE` to its absolute executable path before that
dynamic import. In VS Code
builds that gate SDK extensions behind `chat.canvases.enabled`, enable
that setting, then reopen/resume the chat. The host stores it as `canvasesEnabled`;
`chat.agentHost.canvasesEnabled` is not a recognized VS Code setting. The adapter reports connection in the
timeline when the host actually loads it.

The `ChatCanvases` enterprise policy takes precedence over this preference. An
account with preview features disabled cannot load this SDK-extension route.
Do not edit persisted host state or policy caches to override that restriction.
An isolated SDK test does not prove that the live editor admits the extension.

Incoming messages use the SDK's native `send` API for active/idle conversations.
Acceptance is recorded separately from processing. Ambiguous submissions are
quarantined without automatic resend; inspect the transcript before recovery.
Closed/unloaded conversations do not wake. Normal relay mode only surfaces peer
messages; it does not authorize replies, commands, or autonomous work.

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

## Codex Desktop status

Desktop can use the seven MCP tools without the CLI launcher. The bridge takes its identity
from executor-supplied task metadata, never a seat name or inherited parent-session environment.
Call `chats()` once after opening/resuming a task: this restores its saved rooms and exact seat
names. Distinct tasks in the same project remain distinct, and mismatched metadata is rejected.

The adapter watches joined rooms automatically and forwards incoming messages
through the **existing Desktop IPC router**. It steers active work, or starts a turn when idle.
It does not replace App Server, patch Desktop, change phone/laptop pairings, access the protected
app-tools socket, or answer permission requests. The CLI/Claude delivery paths are unchanged.

This is a private, versioned macOS-tested interface, not a public compatibility guarantee.
If Desktop cannot find the existing task owner, the message remains pending; closed/unloaded
tasks are not guaranteed to wake. After MCP recreation, call `chats()` once to bind the executor
UUID and restore rooms. `chats()` reports delivery status and uncertain receipts. Set the MCP
environment `CHAT_DESKTOP_RELAY=0` to disable the adapter while keeping manual tools.
Windows is not currently supported by this Unix-socket adapter. No database is synchronized
between computers merely because Desktop has paired-device Remote Control.

Validation: `node bridge/test-codex-metadata.mjs` exercises seven tools over real MCP subprocesses,
and `INTERCOM_TEST_METADATA=1 node codex/test-mcp-environment.mjs` verifies the actual Codex App
Server supplies task metadata without a launcher identity file. These are not a claim that
all lifecycle/platform cases have passed. `codex/test-desktop-relay.mjs` and
`codex/test-desktop-ipc-transport.mjs` cover delivery safeguards without a model;
the opt-in `bridge/test-desktop-live.mjs TASK_UUID` targets only a user-authorized
disposable task and uses a temporary chat database.

## Directed delivery

`send({chat, body})` broadcasts. `send({chat, body, to: "reviewer"})` resolves the currently live
seat and stores its session UUID. Delivery and history include a direct message only for its sender
and recipient. The SQLite file is a local collaboration store, not encrypted private messaging;
machine administrators can still inspect it.

## Tests

The package-install regression test installs into an isolated Codex home and starts the
plugin through marketplace discovery (no command, cwd, or bridge-path overrides):

```bash
node --no-warnings codex/test-plugin-install.mjs
```

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

See [session lifecycle and upgrade notes](docs/SESSION-LIFECYCLE.md) for persistent subscriptions,
connection leases, occupied-name handling and delivery reconciliation. After this upgrade, restart
all Claude and Codex participants so old bridges cannot bypass the new ownership checks.
