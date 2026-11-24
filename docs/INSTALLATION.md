# Marketplace installation and updates

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

New CLI shell wrappers apply in a new terminal, and a new MCP connection is needed to adopt newly added tools or skills. Existing Desktop app and Claude processes are not restarted by a coordinated Intercom relay reload; their normal host admission still controls channels and hooks.


## Conversation use

Join an explicitly chosen room with `join({chat,seat?})`. Use `send({chat,to,body})` for one exact live recipient; omitting `to` broadcasts. Saved membership follows the real session UUID. `history({chat,limit,before_id})` reads only visible history; `who` shows current seats. Renames and leaves apply at runtime.

## Coordinated Desktop upgrade and rollback

Setup refuses to replace a running Intercom Desktop service. Preserve its current private registry/configuration and database; check in-flight or uncertain receipts first. Stop only that known relay, run the normal package setup, then bootstrap the same LaunchAgent. A failed update can restore its backed-up package files and known service; never restore an old database over new messages or resend unknown submissions. Desktop and Claude processes do not need restarting for this relay reload.

## Troubleshooting

Membership and automatic delivery readiness are separate. A loaded host must admit the appropriate channel, hook or optional SDK extension. Hook declarations being present do not prove trust or execution. Durable enqueue acceptance does not prove model reading. Inspect an uncertain delivery's actual transcript before recovery; later messages intentionally wait. Generic first-time cutover refuses existing pending barriers instead of skipping them or replaying pre-cutover input.
