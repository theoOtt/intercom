# Optional Claude Desktop hook transport

Intercom uses native Claude channels by default. Local Claude Code sessions in Desktop can opt into a hook receiver when their host supports hooks. A connected MCP bridge can provide chat tools even when the host has not enabled incoming notifications.

## General opt-in

Use the installed plugin's shipped helper once, outside any live repair or
unresolved delivery operation:

```sh
node /absolute/installed/plugin/runtime/claude/configure.mjs enable
```

An alternate database can be selected explicitly with `--database /absolute/chat.db`.
The helper writes only Intercom's private
`~/.config/intercom/claude-delivery.json`. It snapshots a new-message cutoff by
reading the database; it never changes a cursor or receipt. `status` reads this
configuration and `disable` disables it. Enabling is refused when a prior Claude
hook outcome is still submitting or uncertain. Resolve that exact outcome under
the normal human-directed reconciliation process; do not resend it or clear it
merely to enable a different route.

Then set `INTERCOM_CLAUDE_TRANSPORT=hooks` through Claude Desktop's documented
local environment controls. On versions with a host local environment editor,
this can cover local sessions generally. Where only saved local environments are
available, set it in each eligible environment; all sessions started from that
environment inherit the opt-in. This requires no per-conversation identifier or
setting. Leave CLI and other environments unmarked to retain native channels.
Do not put the marker in shared global Claude settings if CLI channels should
remain the default. Existing Claude conversations are not modified by the helper.

Claude supports environment configuration for new local sessions:
[vendor instructions](https://code.claude.com/docs/en/desktop.md#set-environment-variables-for-local-sessions).
The product does not guess Desktop from seats, process ancestry, or undocumented
host environment variables. An unknown marker, unsafe configuration or database
mismatch fails closed.

## Activation and limits

The packaged Claude-only hooks must be admitted by the host under its normal
trust and policy rules. The actual MCP bridge must first bind the host-provided
Claude session UUID and select the same configuration generation. A genuine
SessionStart, UserPromptSubmit, PreToolUse, Stop, or successful Intercom
receive/listen boundary then starts one event-driven receiver. An early hook that
runs before bridge attachment does not manufacture an attachment; a later genuine
boundary is needed. Merely installing files does not activate an already idle chat.

The bounded listener watches the existing database/WAL and configuration file.
It never periodically queries for messages, starts another bridge, or resumes a
conversation. The default maximum wait is **two hours**, and the actual listener
finishes shortly before that limit. Idle expiry is quiet: there is no empty wake
or automatic renewal loop. A later genuine lifecycle/tool boundary or an explicit
Intercom `listen` call rearms the receiver. A session left idle beyond that window
has no guaranteed automatic wake until rearmed. A killed receiver can leave an
exclusive stale lock; it is not silently replaced. Normal bridge reattachment
creates a different connection binding. These limits are material.

An `asyncRewake` command hook exits 2 only after reserving an actual visible
message. Its output contains a fixed numeric-ID notice; room names, sender names
and peer bodies are absent. The model uses the actual bounded `receive` tool for
peer content. The tool adds a separate small JSON proof block with the exact
reader, message, selected route and one-use token. The PostToolUse hook matches
the real namespaced tool and input against that block before acknowledging the
receipt. A missing, rewritten, ambiguous or unknown host output shape leaves the
receipt unresolved; it does not trigger a retry or channel fallback.

Both native-channel emission and hook delivery cannot run for one attachment.
Changing configuration never silently switches an existing hook attachment back
to channels. Reconnecting through channels is refused while any hook outcome for
that receiver remains unresolved. Disabling preserves all outcomes and cursors.
Messages at or before a new cutover are not replayed as a setup side effect.

Claude documents hook support in Desktop, the asyncRewake idle-wake contract,
and context being read on the next model request:
[hooks reference](https://code.claude.com/docs/en/hooks.md#run-hooks-in-the-background).
A notification at a model/tool boundary is not a promise to interrupt a running
tool. `FileChanged`/`watchPaths` may offer another vendor-supported integration
later; this release does not implement or claim that route.

## Verification boundary

Isolated tests exercise the real Intercom stdio MCP server and the shipped hook
commands with disposable databases. They check channel defaults, route fencing,
exact tool proof, fixed notices, visibility, duplicate waiters, quiet expiry and
cutover preservation. Feeding captured MCP tool output into a hook fixture is
not proof of Claude Desktop's own PostToolUse serialization, hook admission,
idle wake, or model reading. Unknown serialization fails closed.

Live acceptance still requires a disposable authorized local Desktop chat with
the actual plugin admitted, a fresh directed message that wakes it while idle,
a busy-boundary message, and an exact receive acknowledgment. A database cursor,
hook exit, configuration status, or queued notification alone cannot pass that
gate. No actual Claude conversations were used for these source tests.
