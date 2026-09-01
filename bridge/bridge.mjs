// bridge.mjs -- per-session Claude Code CHANNEL bridge for multi-session chat.
//
// One stdio MCP subprocess per Claude session. It:
//   * declares the `claude/channel` capability and PUSHES incoming peer messages
//     as channel notifications (this is what wakes an idle session), and
//   * exposes tools: join, leave, chats, send, history, who, rename.
// A session can be in MANY chats at once and join/leave at RUNTIME.
//
// Backing store: one shared SQLite file (CHAT_DB). No Redis, no daemon.
//
// == HARD RULES (learned painfully) ==
//  1. Every value in a channel notification's `params.meta` MUST be a STRING.
//     Claude validates meta with a Zod string schema; a non-string throws inside
//     Claude and SILENTLY DROPS the whole channel connection. String() everything.
//  2. A malformed notification kills the connection -> wrap every push in try/catch
//     so one bad push can never kill the poll loop.
//  3. stdout is the MCP protocol stream. Log ONLY to process.stderr.
//
// Env: CHAT_DB (optional shared DB override). CHAT + SEAT (optional) -> auto-join at startup.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync } from 'node:fs'
import {
  openDb, claimSeat, releaseSeat, listSeats, knownChats,
  sendMessage, messagesAfter, history, maxId,
  getCursor, setCursor, heartbeat, whoOnline,
  getDeliveryCursor, setDeliveryCursor, deleteDeliveryCursor,
  migrateChat, resolveRename, migrateIdentity,
} from './chat-db.mjs'

// Plugin installs intentionally need no machine-specific MCP configuration.
// Existing/manual installs can continue overriding this path with CHAT_DB.
const CHAT_DB = process.env.CHAT_DB || join(homedir(), '.claude', 'intercom', 'chat.db')
mkdirSync(dirname(CHAT_DB), { recursive: true, mode: 0o700 })
const FALLBACK_IDENTITY = `process:${process.pid}:${Date.now()}`
function currentIdentity() {
  if (process.env.CHAT_IDENTITY_FILE) {
    try {
      const fromFile = readFileSync(process.env.CHAT_IDENTITY_FILE, 'utf8').trim()
      if (fromFile) return fromFile
    } catch {}
  }
  if (process.env.CHAT_IDENTITY) return process.env.CHAT_IDENTITY
  // Claude preserves its session UUID across --resume and supplies it to child
  // processes. Prefixing avoids collisions with Codex UUIDs in the same database.
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude:${process.env.CLAUDE_CODE_SESSION_ID}`
  if (process.env.CLAUDE_SESSION_ID) return `claude:${process.env.CLAUDE_SESSION_ID}`
  return FALLBACK_IDENTITY
}
const log = (m) => process.stderr.write(`[bridge] ${m}\n`)

const db = openDb(CHAT_DB)

// In-memory membership: chat -> { seat, cursor }. This is what the poll loop walks.
const joined = new Map()
const CODEX_RELAY_CONSUMER = 'codex-app-server'

const server = new Server(
  { name: 'intercom', version: '0.4.5' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'This is multi-session chat between Claude Code sessions over a shared store. ' +
      'Channel events are INCOMING messages from peers, formatted "[<chat>] <seat>: <text>". ' +
      'Default behavior is RELAY: show an incoming message to your user and reply only on their ' +
      'direction (autonomous back-and-forth only if the user explicitly says so). ' +
      'Tools: join({chat,seat?}) to enter a chat (seat auto-assigned if omitted); ' +
      'leave({chat}); chats() to list joined + available chats; send({chat?,body,to?}) to post ' +
      'a broadcast or address one live seat; ' +
      '(chat optional when in exactly one); history({chat?,limit?,before_id?}) for recent context; ' +
      'who({chat?}) for who is online. You may be in several chats at once.',
  }
)

// ---- helpers ---------------------------------------------------------------
const text = (t) => ({ content: [{ type: 'text', text: t }] })

function resolveChat(arg) {
  if (arg) {
    if (!joined.has(arg)) throw new Error(`not joined to chat "${arg}" -- call join first`)
    return arg
  }
  if (joined.size === 1) return [...joined.keys()][0]
  if (joined.size === 0) throw new Error('not in any chat -- call join({chat}) first')
  throw new Error(`in multiple chats (${[...joined.keys()].join(', ')}) -- pass chat explicitly`)
}

function doJoin(chat, seat) {
  const identity = currentIdentity()
  const previous = joined.get(chat)
  const assigned = claimSeat(db, chat, seat || null, identity)
  if (!assigned) {
    throw new Error(
      seat ? `seat "${seat}" in "${chat}" is taken` : `chat "${chat}" is full (seats a-h all claimed)`
    )
  }
  // Start caught-up so history is not replayed as unread.
  let cur = getCursor(db, chat, assigned)
  if (cur === null) { cur = maxId(db, chat); setCursor(db, chat, assigned, cur) }
  // Establish the Codex wake boundary at join time. The relay discovers rooms
  // asynchronously; without this independent cursor, a message arriving between
  // join and discovery could be mistaken for old history and skipped.
  if ((identity.startsWith('codex:') || process.env.CHAT_IDENTITY_FILE) &&
      getDeliveryCursor(db, chat, identity, CODEX_RELAY_CONSUMER) === null) {
    setDeliveryCursor(db, chat, identity, CODEX_RELAY_CONSUMER, cur)
  }
  if (previous && previous.seat !== assigned) releaseSeat(db, chat, previous.seat)
  joined.set(chat, { seat: assigned, cursor: cur, identity })
  log(`joined chat="${chat}" seat="${assigned}" identity="${identity}" cursor=${cur}`)
  const peers = listSeats(db, chat).filter((s) => s.seat !== assigned).map((s) => s.seat)
  return { assigned, peers, online: whoOnline(db, chat) }
}

// ---- tools -----------------------------------------------------------------
const TOOLS = [
  { name: 'join', description: 'Join a chat (enter it and start receiving its messages). Seat auto-assigned if omitted.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' }, seat: { type: 'string', description: 'optional seat label; auto a-h if omitted' } }, required: ['chat'] } },
  { name: 'leave', description: 'Leave a chat (stop receiving its messages, free your seat).',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'] } },
  { name: 'chats', description: 'List chats you are in (with your seat) and all chats available to join.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'send', description: 'Send a broadcast, or address one live seat with `to`. `chat` is optional when you are in exactly one chat.',
    inputSchema: { type: 'object', properties: {
      chat: { type: 'string' },
      body: { type: 'string' },
      to: { type: 'string', description: 'optional exact live seat name; only that session receives the message' },
    }, required: ['body'] } },
  { name: 'history', description: 'Recent messages for catch-up. Page back with before_id.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' }, limit: { type: 'number' }, before_id: { type: 'number' } } } },
  { name: 'who', description: 'Which seats are currently online in a chat.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } } } },
  { name: 'rename', description: 'Rename a chat. All members pick up the new name automatically.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' }, to: { type: 'string' } }, required: ['to'] } },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {}
  switch (req.params.name) {
    case 'join': {
      const r = doJoin(a.chat, a.seat)
      const suffixed = a.seat && r.assigned !== a.seat
      return text(
        `Joined "${a.chat}" as seat "${r.assigned}". ` +
        (suffixed ? `(Requested "${a.seat}" but a live session holds it, so you are "${r.assigned}".) ` : '') +
        (r.peers.length ? `Other seats: ${r.peers.join(', ')}. ` : 'No other seats yet. ') +
        (r.online.length ? `Online now: ${r.online.join(', ')}.` : '')
      )
    }
    case 'leave': {
      const chat = resolveChat(a.chat)
      const { seat } = joined.get(chat)
      deleteDeliveryCursor(db, chat, currentIdentity(), CODEX_RELAY_CONSUMER)
      releaseSeat(db, chat, seat)
      joined.delete(chat)
      log(`left chat="${chat}" seat="${seat}"`)
      return text(`Left "${chat}".`)
    }
    case 'chats': {
      const mine = [...joined.entries()].map(([c, v]) => `${c} (seat ${v.seat})`)
      const all = knownChats(db)
      return text(
        `You are in: ${mine.length ? mine.join(', ') : '(none)'}\n` +
        `Available chats: ${all.length ? all.join(', ') : '(none)'}`
      )
    }
    case 'send': {
      const chat = resolveChat(a.chat)
      if (typeof a.body !== 'string' || !a.body.trim()) throw new Error('send requires a non-empty body')
      const { seat } = joined.get(chat)
      const targetName = typeof a.to === 'string' ? a.to.trim() : ''
      let target = null
      if (targetName) {
        target = listSeats(db, chat).find((candidate) => candidate.seat === targetName)
        if (!target) {
          const available = listSeats(db, chat).map((candidate) => candidate.seat)
          throw new Error(
            `seat "${targetName}" is not currently in "${chat}"` +
            (available.length ? `; available seats: ${available.join(', ')}` : '; no seats are present')
          )
        }
        if (target.identity === currentIdentity()) throw new Error('cannot send a direct message to your own seat')
      }
      const id = sendMessage(db, chat, seat, a.body.trim(), {
        senderIdentity: currentIdentity(),
        toSeat: target?.seat ?? null,
        toIdentity: target?.identity ?? null,
      })
      log(`sent chat="${chat}" seat="${seat}" to="${target?.seat ?? '*'}" id=${id}`)
      return text(
        target
          ? `Sent directly to "${target.seat}" in "${chat}" as "${seat}" (id ${id}).`
          : `Broadcast to "${chat}" as "${seat}" (id ${id}).`
      )
    }
    case 'history': {
      const chat = resolveChat(a.chat)
      const rows = history(db, chat, {
        limit: a.limit ?? 30,
        beforeId: a.before_id,
        viewerIdentity: currentIdentity(),
      })
      if (!rows.length) return text(`No history in "${chat}".`)
      return text(rows.map((r) => {
        const route = r.to_seat ? `${r.seat} -> ${r.to_seat}` : r.seat
        return `#${r.id} ${route}: ${r.body ?? r.summary ?? r.ref ?? ''}`
      }).join('\n'))
    }
    case 'who': {
      const chat = resolveChat(a.chat)
      const on = whoOnline(db, chat)
      return text(on.length ? `Online in "${chat}": ${on.join(', ')}` : `Nobody online in "${chat}".`)
    }
    case 'rename': {
      const chat = resolveChat(a.chat)
      const to = (a.to || '').trim()
      if (!to || /[^a-zA-Z0-9._-]/.test(to)) throw new Error('rename target must use only a-z A-Z 0-9 . _ -')
      if (to === chat) return text(`Chat is already named "${chat}".`)
      const state = joined.get(chat)
      migrateChat(db, chat, to)
      joined.delete(chat)
      joined.set(to, state)
      setCursor(db, to, state.seat, state.cursor)
      // Human-readable note in the new chat; peers also auto-switch via the rename table.
      sendMessage(db, to, state.seat, `(renamed this chat from "${chat}" to "${to}")`)
      log(`renamed "${chat}" -> "${to}"`)
      return text(`Renamed "${chat}" to "${to}". Other members will pick it up automatically.`)
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ---- connect + loops -------------------------------------------------------
await server.connect(new StdioServerTransport())
log(`connected (identity=${currentIdentity()}, db=${CHAT_DB})`)

// Startup auto-join. Explicit CHAT env wins; otherwise, when CHAT_AUTOJOIN_PROJECT is
// truthy, join a chat named after the PROJECT (basename of the working directory) so
// sessions in the same project automatically coordinate with each other.
function projectChat() {
  const raw = process.env.CHAT_PROJECT || basename(process.cwd())
  return (raw || 'project').replace(/[^a-zA-Z0-9._-]/g, '-')
}
let startupChat = process.env.CHAT || null
if (!startupChat && /^(1|true|yes|on)$/i.test(process.env.CHAT_AUTOJOIN_PROJECT ?? '1')) {
  startupChat = projectChat()
}
if (startupChat) {
  try {
    const r = doJoin(startupChat, process.env.SEAT)
    log(`startup auto-join chat="${startupChat}" seat="${r.assigned}" (cwd=${process.cwd()})`)
  } catch (e) { log(`startup auto-join failed: ${e.message}`) }
}

// Poll every joined chat; push new peer messages as channel notifications.
const POLL_MS = 1500
setInterval(() => {
  // 0) Adopt a durable identity if the launcher learned it after startup.
  for (const [chat, state] of joined) {
    const identity = currentIdentity()
    if (identity === state.identity) continue
    try {
      migrateIdentity(db, chat, state.seat, state.identity, identity)
      log(`identity migrated chat="${chat}" seat="${state.seat}" "${state.identity}" -> "${identity}"`)
      state.identity = identity
    } catch (err) {
      log(`identity migration error chat="${chat}": ${err}`)
    }
  }

  // 1) Apply any chat renames to our membership (snapshot keys since we mutate the map).
  for (const chat of [...joined.keys()]) {
    const resolved = resolveRename(db, chat)
    if (resolved === chat || !joined.has(chat)) continue
    const state = joined.get(chat)
    joined.delete(chat)
    if (joined.has(resolved)) {
      // Already tracking the target name -> keep the lower cursor so nothing is missed.
      const ex = joined.get(resolved)
      ex.cursor = Math.min(ex.cursor, state.cursor)
    } else {
      joined.set(resolved, state)
      setCursor(db, resolved, state.seat, state.cursor)
    }
    server
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[${resolved}] system: this chat was renamed from "${chat}" to "${resolved}"`,
          meta: { chat: String(resolved), event: 'rename', from: String(chat) },
        },
      })
      .catch((err) => log(`rename notice error: ${err}`))
    log(`applied rename "${chat}" -> "${resolved}"`)
  }

  // 2) Poll each joined chat for new peer messages.
  for (const [chat, state] of joined) {
    try {
      const rows = messagesAfter(db, chat, state.seat, state.cursor, { identity: state.identity })
      for (const row of rows) {
        server
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content: `[${chat}] ${row.seat}${row.to_seat ? ` -> ${row.to_seat}` : ''}: ${row.body}`,
              // meta values MUST be strings (see HARD RULES above).
              meta: {
                chat: String(chat),
                seat: String(row.seat),
                id: String(row.id),
                direct: String(Boolean(row.to_identity)),
                to: String(row.to_seat || ''),
              },
            },
          })
          .then(() => log(`pushed chat="${chat}" id=${row.id} from="${row.seat}"`))
          .catch((err) => log(`push error chat="${chat}" id=${row.id}: ${err}`))
        if (row.id > state.cursor) {
          state.cursor = row.id
          setCursor(db, chat, state.seat, row.id) // persist -> lossless across respawn
        }
      }
    } catch (err) {
      log(`poll error chat="${chat}": ${err}`)
    }
  }
}, POLL_MS)

// Presence heartbeat for every joined chat.
setInterval(() => {
  const now = Date.now()
  for (const [chat, state] of joined) {
    try { heartbeat(db, chat, state.seat, now) } catch (err) { log(`heartbeat error chat="${chat}": ${err}`) }
  }
}, 5000)

log(`loops started (poll=${POLL_MS}ms)`)

// On a clean quit (Claude terminates the subprocess), release our seats so a
// returning session reclaims them immediately instead of waiting on the stale
// timer. A hard kill (SIGKILL / reaper) can't run this -- those seats free via
// the ~30s presence-stale path instead.
function shutdown() {
  for (const [chat, state] of joined) {
    try { releaseSeat(db, chat, state.seat) } catch {}
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
