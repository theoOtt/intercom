# session-chat bridge

A standard MCP server and Claude Code **channel** that lets Claude Code and Codex sessions chat
in real time
through a shared SQLite file — with **idle-wake** (an incoming message wakes an idle
session into a turn, no polling). Replaces the old bash-watcher + `.md` file approach.

## How it works

- The bridge is a **per-session stdio MCP server** launched with your `claude` session.
- It declares the experimental `claude/channel` capability, so it can **push** incoming
  peer messages into your session (this is what wakes an idle session).
- It exposes tools: `join`, `leave`, `chats`, `send`, `history`, `who`, `rename`.
- `send` supports broadcasts and direct delivery to one exact live seat. Direct visibility is
  bound to the resumable agent session UUID, so reusing a display label cannot leak old messages.
- All messages/seats/cursors/presence live in one **shared SQLite file**. `CHAT_DB` may override
  its path; marketplace plugins default to `~/.claude/intercom/chat.db` in both products.
  No Redis, no daemon. Every session points at the same file.
- A session can be in **many chats at once** and join/leave at **runtime**.

## Requirements

- Node 22.5+ (uses built-in `node:sqlite`). Tested on Node 24.
- Claude Code with channel support (the `--dangerously-load-development-channels` flag).
  NOTE: channels are an **experimental** Claude Code feature; the flag name reflects that.
  Your chat data lives in SQLite and does not depend on the channel — if the channel
  mechanism ever changes, you lose instant wake, not your messages.

## Install / launch

1. Pick a shared DB path, e.g. `~/.claude/session-chat-v2/chat.db`, and an MCP config
   (`mcp.json`) that registers this bridge as a server named `chat`:

   ```json
   {
     "mcpServers": {
       "chat": {
         "command": "node",
         "args": ["/ABS/PATH/session-chat-mcp/bridge/bridge.mjs"],
         "env": { "CHAT_DB": "/ABS/PATH/.claude/session-chat-v2/chat.db" }
       }
     }
   }
   ```
   Optional env: `CHAT` + `SEAT` to auto-join a chat at startup; `CHAT_IDENTITY` to make
   seat reclaim stable across restarts.

2. Launch a session with the bridge + the channel enabled:

   ```bash
   claude --mcp-config /ABS/PATH/mcp.json --dangerously-load-development-channels server:chat
   ```

3. To avoid typing that every time, alias it (so plain `claude` always loads it; you only
   `join` a chat when you actually want to chat):

   ```bash
   alias claude='claude --mcp-config /ABS/PATH/mcp.json --dangerously-load-development-channels server:chat'
   ```

## Usage (in-session)

- Join a chat: *"join the chat `ml-sync`"* → the session calls `join({chat:"ml-sync"})`
  and is assigned a free seat (a-h) automatically, or pass a label.
- Also join another: *"also join `backend-sessions`"* → you're now in both; messages from
  either wake you, tagged `[ml-sync] ...` / `[backend-sessions] ...`.
- Send: *"tell the chat X"* → `send({body:"X"})` (add `chat` if you're in more than one).
- Direct: *"tell reviewer X"* → `send({body:"X",to:"reviewer"})`; other seats ignore it.
- Catch up: `history({chat, limit})`. Who's online: `who({chat})`. Leave: `leave({chat})`.

Incoming messages arrive as channel events formatted `[<chat>] <seat>: <text>` and the
session (per its skill) relays them to you.

## Troubleshooting

- **Messages send but peers never wake.** Almost certainly a `meta` type bug. Every value
  in a channel notification's `params.meta` MUST be a string — a non-string throws inside
  Claude and **silently drops the channel connection**. This bridge stringifies all meta;
  if you extend it, keep that rule.
- **Read the channel's real errors.** Claude captures the bridge's stderr + connection
  errors at:
  `~/Library/Caches/claude-cli-nodejs/<encoded-cwd>/mcp-logs-chat/<timestamp>.jsonl`
  Look for `Connection error` / `connection dropped`.
- **Reset a chat / everything.** Messages are rows in `CHAT_DB`. Delete rows for one chat,
  or delete the DB file to reset all chats. Seats free automatically when a session leaves.

## Files

- `chat-db.mjs` — SQLite schema + data access (multi-chat).
- `bridge.mjs` — the channel MCP server (tools + poll/push + presence).
- `test-db.mjs` — headless data-layer tests (`node test-db.mjs`).
