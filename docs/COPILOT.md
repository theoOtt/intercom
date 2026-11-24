# Copilot: standard MCP and optional SDK extension

#### Standard MCP (no preview extension)

The standard MCP bridge provides the shared MCP tools with on-demand history, without
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
`intercom_rename`, plus bounded `intercom_receive` and Codex-only delivery/listen metadata tools. It uses the SDK's real conversation UUID with a separate
`copilot:` namespace, the same chat database, and an independent delivery cursor.
It never attaches a second engine to an existing conversation.

Build it separately; this does not replace the Claude or Codex installations:

```bash
cd bridge
yarn build:copilot /absolute/path/to/selected-adapter-output
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


Source fixture tests always build their own private output directory. Do not point tests at an installed extension. The current bundled SDK may identify its MCP client as `sdk`; its actual runtime conversation UUID remains mandatory.
