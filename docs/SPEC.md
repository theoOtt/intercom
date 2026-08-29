# Session-Chat v2 (MCP + Channel) — Historical Design Spec

> This document records the original Claude-only design. The current Claude + Codex architecture,
> directed delivery, schema, installation, and operating instructions are in the repository README.

Status: in build (2026-07-13). Non-destructive: does NOT touch the in-use `~/.claude/skills/session-chat/` until a deliberate cutover.

## 1. Why

The v1 session-chat used per-session background `bash` watchers as the "doorbell." Claude Code's harness **reaps `run_in_background` bash tasks** (batch "reaper cycle", coupled to session activity), and SIGTERM to the wrapper does not propagate to the watch.sh child, leaving PID-1 orphans and stacked duplicates. Net: watchers die constantly and unpredictably; the file-watch + `.md` model is fragile.

## 2. What (validated)

Replace the whole mechanism with **Claude Code Channels**. VERIFIED empirically 2026-07-13:
- A channel push (`notifications/claude/channel`) **wakes a running, idle session** into a turn (~2s). No polling, no keypress.
- A **per-session channel bridge** (stdio MCP subprocess) + **one shared SQLite file** brokers messages across sessions: session A's `send` tool writes a row → B's bridge poll spots it → channel push → **B wakes and renders it**. Confirmed with two real sessions.
- No Redis, no separate daemon. The "backend" is a file; the "notifier" is the bridge subprocess.

## 3. Architecture (three pieces)

1. **Bridge (MCP server, the engine)** — `bridge/bridge.mjs`. Per-session stdio MCP that (a) declares the channel capability and pushes incoming peer messages (idle-wake), (b) exposes tools (`send`, `history`, `who`), (c) reads/writes the shared SQLite file, (d) maintains presence. Launched per session via `--mcp-config` + `--dangerously-load-development-channels server:chat`. Config carries CHAT_DB, CHAT (chat name), SEAT.
2. **Skill (the workflow wrapper)** — `skill/SKILL.md`. Defines the human-facing protocol: join/seat, relay incoming to the user, send replies via the tool, presence, history, end/leave. Drives the MCP; no bash watchers.
3. **Importer** — `import/import.mjs`. Losslessly imports existing `~/.claude/session-chat/<chat>/<seat>.md` history into the SQLite store. Non-destructive (never deletes the originals; verify before any cutover).

## 4. SQLite schema (one shared file, multi-chat, multi-seat)

```sql
CREATE TABLE IF NOT EXISTS messages (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  chat  TEXT NOT NULL,
  seat  TEXT NOT NULL,
  type  TEXT NOT NULL DEFAULT 'msg',   -- msg | artifact | system
  body  TEXT,                          -- for msg
  ref   TEXT,                          -- for artifact: absolute path
  summary TEXT,                        -- for artifact: one-line
  ts    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat, id);

CREATE TABLE IF NOT EXISTS seats (
  chat TEXT NOT NULL, seat TEXT NOT NULL,
  identity TEXT, joined_ts TEXT,
  PRIMARY KEY (chat, seat)
);

CREATE TABLE IF NOT EXISTS cursors (        -- durable per-seat read position
  chat TEXT NOT NULL, seat TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat, seat)
);

CREATE TABLE IF NOT EXISTS presence (
  chat TEXT NOT NULL, seat TEXT NOT NULL,
  last_seen_epoch INTEGER NOT NULL,
  PRIMARY KEY (chat, seat)
);
```

Stream ordering = `messages.id` (monotonic). Replaces v1's per-seat `seq:` bookkeeping.

## 5. Bridge behavior

- **Env:** `CHAT_DB` (shared db path), `CHAT` (chat name), `SEAT` (this session's seat).
- **Startup:** open db; ensure schema; register seat; set in-memory cursor = persisted `cursors.last_read_id` (or `MAX(id)` for this chat if none — start caught-up, no history spam).
- **Poll loop (~1500ms):** `SELECT * FROM messages WHERE chat=:chat AND id > :cursor AND seat != :seat ORDER BY id`; for each row push a channel notification, advance cursor, **persist cursor** (so a reaped/respawned bridge resumes losslessly — the reliability guarantee). Wrap in try/catch; never let the loop die.
- **Presence heartbeat (~5s):** upsert `presence(chat, seat, now_epoch)`.
- **Tools:**
  - `send({ body })` → insert a `type=msg` row for (chat, seat).
  - `history({ limit=30, before_id? })` → windowed read (recent N, or page back before an id) for catch-up without flooding context.
  - `who()` → seats with `presence.last_seen_epoch` within the last 10s.
- **CRITICAL robustness rules (learned the hard way):**
  1. **All `params.meta` values MUST be strings.** Claude validates meta with a Zod string schema; a numeric value throws "expected string, received number" IN CLAUDE and **drops the channel connection silently**. `String(...)` everything in meta.
  2. A malformed notification kills the connection — **validate before pushing**; catch notification errors so one bad push can't kill the loop.
  3. stdio MCP is NOT auto-reconnected (per mcp.md). If the connection drops, the session must respawn the bridge — the persisted cursor makes respawn lossless. (Reconnect/respawn story: OPEN — see §9.)
- **stdout is the MCP protocol stream — log ONLY to stderr.**

## 6. Skill responsibilities (`skill/SKILL.md`)

- Join: instruct launching the session with the bridge (see §7). Pick seat (named or letter).
- Incoming: channel events arrive as `<channel source="chat" ...>` with `content = "<seat>: <body>"`. Default RELAY mode — show to the user, reply on their direction. Autonomous mode only on explicit opt-in (carry over v1 rules + 15-reply cap).
- Send: call the `send` tool.
- Catch-up on join: call `history()` and show recent context.
- Presence: `who()`. End/leave: `type=system` messages (`event: end|leave`) instead of magic last-lines.
- Artifacts: long content stays as files under an `artifacts/` dir, referenced by absolute path via a `type=artifact` message (envelopes-not-payloads rule carried over).

## 7. Launch / config / global enablement

- Per-session launch: `claude --mcp-config <cfg>.json --dangerously-load-development-channels server:chat`, where `<cfg>` defines an MCP server named `chat` → `node bridge.mjs` with env `{ CHAT_DB, CHAT, SEAT }`.
- **OPEN:** determine whether the channel can be enabled globally via `settings.json` (always-on for every session) vs. only the CLI flag. If CLI-only, provide a launcher wrapper/alias (e.g. `chat <name> <seat>`). This is what makes "all sessions switch to this" seamless.

## 8. History import (non-destructive — REQUIRED)

- `import/import.mjs`: snapshot `~/.claude/session-chat/` to a timestamped backup; parse every `<seat>.md` block (seq, from, time, body); merge-sort across seats by `time`; `INSERT` into `messages` with `ts` preserved and `id` in chronological order; `type=msg`, body verbatim (lossless, no reclassification). Artifacts carry over as files.
- Verify (per-chat counts + date range) and show the user BEFORE any cutover. Originals are never deleted by this tool.

## 9. Open validations / risks

- **Reaper endurance:** confirm the bridge/channel subprocess survives long idle + heavy session activity (monitor running). If channels ARE reaped, add a respawn story.
- **Reconnect/respawn:** if the stdio channel drops, how does the session get it back? (persisted cursor = lossless resume; mechanism TBD.)
- **Global channel enablement** (§7).

## 10. Cutover plan (deliberate, with sign-off)

1. Build + validate v2 alongside v1 (new names, nothing touched).
2. Import v1 history → SQLite; verify with the user.
3. Show the user the exact global-CLAUDE.md changes; apply only on sign-off.
4. Switch the `session-chat` skill to v2 (or install as new, deprecate v1).
5. Remove/retire the old bash-watcher skill only after live sessions have moved over.

## 11. Instructions/docs deliverables (must be thorough — "fully understood")

- `README.md`: what it is, architecture, install, launch, per-session usage, troubleshooting (incl. the meta-string gotcha), how to reset a chat.
- `skill/SKILL.md`: complete protocol, self-contained.
- Global-CLAUDE.md snippet: how every session knows to use v2 for chat.
- Inline code docs in bridge/importer.
