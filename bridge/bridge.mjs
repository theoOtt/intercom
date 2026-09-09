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
import { randomUUID } from 'node:crypto'
import { codexThreadId } from './codex-metadata.mjs'
import {
  atomic,
  claimConnection,
  renewConnection,
  detachConnection,
  attachRooms,
  joinRoom,
  leaveRoom,
  liveMemberships,
  subscriptions,
} from './session-store.mjs'
import {
  openDb,
  listSeats,
  knownChats,
  sendMessage,
  messagesAfter,
  history,
  setCursor,
  whoOnline,
  getDeliveryCursor,
  setDeliveryCursor,
  migrateChat,
} from './chat-db.mjs'

// Plugin installs intentionally need no machine-specific MCP configuration.
// Existing/manual installs can continue overriding this path with CHAT_DB.
const CHAT_DB = process.env.CHAT_DB || join(homedir(), '.claude', 'intercom', 'chat.db')
mkdirSync(dirname(CHAT_DB), { recursive: true, mode: 0o700 })
const FALLBACK_IDENTITY = `process:${process.pid}:${Date.now()}`
function currentIdentity() {
  const host = server.getClientVersion()?.name || ''
  // Nested agents inherit shell environment. A Claude reviewer launched by
  // Codex must never consume its parent's identity file, or vice versa.
  if (/claude/i.test(host)) {
    const id = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID
    return id ? `claude:${id}` : FALLBACK_IDENTITY
  }
  if (process.env.CHAT_IDENTITY_FILE) {
    try {
      const fromFile = readFileSync(process.env.CHAT_IDENTITY_FILE, 'utf8').trim()
      if (fromFile) return fromFile
    } catch {}
  }
  if (process.env.CHAT_IDENTITY) return process.env.CHAT_IDENTITY
  if (/codex/i.test(host)) return FALLBACK_IDENTITY
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
const connection = randomUUID()
let identity = null
let attachmentError = null
let conflicts = []
let metadataIdentity = null

function refreshMemberships() {
  joined.clear()
  for (const row of liveMemberships(db, identity, connection)) {
    joined.set(row.chat, {
      seat: row.seat,
      identity,
      cursor: getDeliveryCursor(db, row.chat, identity, 'claude-channel') ?? 0,
    })
  }
}

function activateIdentity() {
  if (identity || attachmentError) return
  if (!server.getClientVersion()) return // wait for the MCP host's initialize handshake
  const candidate = metadataIdentity || currentIdentity()
  // Desktop does not run the CLI launcher. Its executor identifies the task in
  // tool-call metadata, which arrives after initialize. Do not poison startup
  // or guess a task from CODEX_THREAD_ID inherited through a parent shell.
  if (/codex/i.test(server.getClientVersion()?.name || '') &&
      candidate === FALLBACK_IDENTITY) return
  // The resume picker and forks must resolve their ACTUAL thread before any seat
  // is claimed. Never migrate provisional subscriptions into an existing owner.
  if (process.env.CHAT_IDENTITY_FILE && candidate.startsWith('codex-startup:')) return
  if (!/^(codex|claude):.+/.test(candidate)) {
    attachmentError =
      'No resumable session ID available. Launch Codex through the Intercom wrapper or Claude Code with its session ID environment; a PID or seat name cannot identify a conversation.'
    log(`ATTACHMENT REJECTED: ${attachmentError}`)
    return
  }
  try {
    claimConnection(
      db,
      candidate,
      'bridge',
      connection,
      Date.now(),
      candidate.startsWith('codex:') ? process.env.CHAT_IDENTITY_FILE || null : null
    )
    identity = candidate
    conflicts = attachRooms(db, identity, connection, startupChat, process.env.SEAT)
    refreshMemberships()
    log(
      `attached identity="${identity}" connection="${connection}" rooms=${JSON.stringify([...joined.keys()])}`
    )
    for (const conflict of conflicts) log(`RESTORE CONFLICT: ${conflict}`)
  } catch (error) {
    attachmentError = error.message
    if (identity) detachConnection(db, identity, 'bridge', connection)
    identity = null
    log(`ATTACHMENT REJECTED: ${attachmentError}`)
  }
}

const server = new Server(
  { name: 'intercom', version: '0.5.0' },
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
  const assigned = joinRoom(db, identity, connection, chat, seat)
  refreshMemberships()
  conflicts = conflicts.filter((message) => !message.startsWith(`Room ${chat}:`))
  log(`joined chat="${chat}" seat="${assigned}" identity="${identity}"`)
  const peers = listSeats(db, chat)
    .filter((s) => s.seat !== assigned)
    .map((s) => s.seat)
  return { assigned, peers, online: whoOnline(db, chat) }
}

// ---- tools -----------------------------------------------------------------
const TOOLS = [
  {
    name: 'join',
    description:
      'Join a chat (enter it and start receiving its messages). Seat auto-assigned if omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        seat: { type: 'string', description: 'optional seat label; auto a-h if omitted' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'leave',
    description: 'Leave a chat (stop receiving its messages, free your seat).',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'] },
  },
  {
    name: 'chats',
    description: 'List chats you are in (with your seat) and all chats available to join.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send',
    description:
      'Send a broadcast, or address one live seat with `to`. `chat` is optional when you are in exactly one chat.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        body: { type: 'string' },
        to: {
          type: 'string',
          description: 'optional exact live seat name; only that session receives the message',
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'history',
    description: 'Recent messages for catch-up. Page back with before_id.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        limit: { type: 'number' },
        before_id: { type: 'number' },
      },
    },
  },
  {
    name: 'who',
    description: 'Which seats are currently online in a chat.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } } },
  },
  {
    name: 'rename',
    description: 'Rename a chat. All members pick up the new name automatically.',
    inputSchema: {
      type: 'object',
      properties: { chat: { type: 'string' }, to: { type: 'string' } },
      required: ['to'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let supplied = null
  if (/codex/i.test(server.getClientVersion()?.name || '')) {
    const thread = codexThreadId(req.params._meta)
    supplied = thread ? `codex:${thread}` : null
    if (metadataIdentity && supplied !== metadataIdentity)
      throw new Error('Missing or different task metadata on a bound Intercom connection; reconnect this task.')
    if (supplied && identity && supplied !== identity)
      throw new Error('Codex task metadata does not match the Intercom launcher identity; refusing cross-session access.')
    if (supplied && !identity && !process.env.CHAT_IDENTITY_FILE && !process.env.CHAT_IDENTITY)
      metadataIdentity = supplied
  }
  activateIdentity()
  // The identity file can become ready on this very call, after the check above.
  if (supplied && identity && supplied !== identity)
    throw new Error('Codex task metadata does not match the Intercom launcher identity; refusing cross-session access.')
  if (attachmentError) throw new Error(attachmentError)
  if (!identity)
    throw new Error('Waiting for the actual Codex thread ID; retry after the relay attaches, or use a Desktop executor that supplies task metadata.')
  return atomic(db, () => {
    renewConnection(db, identity, 'bridge', connection)
    refreshMemberships()
    const a = req.params.arguments || {}
    switch (req.params.name) {
      case 'join': {
        const r = doJoin(a.chat, a.seat)
        const suffixed = a.seat && r.assigned !== a.seat
        return text(
          `Joined "${a.chat}" as seat "${r.assigned}". ` +
            (suffixed
              ? `(Requested "${a.seat}" but a live session holds it, so you are "${r.assigned}".) `
              : '') +
            (r.peers.length ? `Other seats: ${r.peers.join(', ')}. ` : 'No other seats yet. ') +
            (r.online.length ? `Online now: ${r.online.join(', ')}.` : '')
        )
      }
      case 'leave': {
        const chat = a.chat || resolveChat()
        leaveRoom(db, identity, connection, chat)
        joined.delete(chat)
        conflicts = conflicts.filter((message) => !message.startsWith(`Room ${chat}:`))
        log(`left chat="${chat}"`)
        return text(`Left "${chat}".`)
      }
      case 'chats': {
        const mine = [...joined.entries()].map(([c, v]) => `${c} (seat ${v.seat})`)
        const all = knownChats(db)
        return text(
          `You are in: ${mine.length ? mine.join(', ') : '(none)'}\n` +
            `Available chats: ${all.length ? all.join(', ') : '(none)'}\n` +
            `Identity: ${identity}\n` +
            (metadataIdentity ? 'Delivery: MCP pull-only; automatic Desktop push/idle wake is not connected.\n' : '') +
            `Saved rooms: ${
              subscriptions(db, identity)
                .map((s) => `${s.chat} (${s.seat})`)
                .join(', ') || '(none)'
            }\n` +
            (conflicts.length ? `Restore conflicts:\n${conflicts.join('\n')}` : '') +
            db
              .prepare(
                `SELECT message_id,chat,state FROM delivery_receipts
          WHERE identity=? AND state IN ('submitting','uncertain')`
              )
              .all(identity)
              .map(
                (r) => `\nDelivery needs reconciliation: #${r.message_id} in ${r.chat} (${r.state})`
              )
              .join('')
        )
      }
      case 'send': {
        const chat = resolveChat(a.chat)
        if (typeof a.body !== 'string' || !a.body.trim())
          throw new Error('send requires a non-empty body')
        const { seat } = joined.get(chat)
        const targetName = typeof a.to === 'string' ? a.to.trim() : ''
        let target = null
        if (targetName) {
          target = listSeats(db, chat).find((candidate) => candidate.seat === targetName)
          if (target && !whoOnline(db, chat, 30).includes(target.seat)) target = null
          if (!target) {
            const available = listSeats(db, chat).map((candidate) => candidate.seat)
            throw new Error(
              `seat "${targetName}" is not currently in "${chat}"` +
                (available.length
                  ? `; available seats: ${available.join(', ')}`
                  : '; no seats are present')
            )
          }
          if (target.identity === identity)
            throw new Error('cannot send a direct message to your own seat')
        }
        const id = sendMessage(db, chat, seat, a.body.trim(), {
          senderIdentity: identity,
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
          viewerIdentity: identity,
        })
        if (!rows.length) return text(`No history in "${chat}".`)
        return text(
          rows
            .map((r) => {
              const route = r.to_seat ? `${r.seat} -> ${r.to_seat}` : r.seat
              return `#${r.id} ${route}: ${r.body ?? r.summary ?? r.ref ?? ''}`
            })
            .join('\n')
        )
      }
      case 'who': {
        const chat = resolveChat(a.chat)
        const on = whoOnline(db, chat)
        return text(
          on.length ? `Online in "${chat}": ${on.join(', ')}` : `Nobody online in "${chat}".`
        )
      }
      case 'rename': {
        const chat = resolveChat(a.chat)
        const to = (a.to || '').trim()
        if (!to || /[^a-zA-Z0-9._-]/.test(to))
          throw new Error('rename target must use only a-z A-Z 0-9 . _ -')
        if (to === chat) return text(`Chat is already named "${chat}".`)
        const state = joined.get(chat)
        migrateChat(db, chat, to)
        joined.delete(chat)
        joined.set(to, state)
        setCursor(db, to, state.seat, state.cursor)
        // Human-readable note in the new chat; peers also auto-switch via the rename table.
        sendMessage(db, to, state.seat, `(renamed this chat from "${chat}" to "${to}")`, {
          senderIdentity: identity,
        })
        log(`renamed "${chat}" -> "${to}"`)
        return text(`Renamed "${chat}" to "${to}". Other members will pick it up automatically.`)
      }
      default:
        throw new Error(`unknown tool: ${req.params.name}`)
    }
  })
})

// ---- connect + loops -------------------------------------------------------
await server.connect(new StdioServerTransport())
log(`connected (awaiting host identity, db=${CHAT_DB})`)

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
activateIdentity()
setInterval(activateIdentity, 250)

// Poll every joined chat; push new peer messages as channel notifications.
const POLL_MS = 1500
let polling = false
setInterval(async () => {
  if (!identity || polling || attachmentError) return
  polling = true
  try {
    renewConnection(db, identity, 'bridge', connection)
    refreshMemberships()
    if (identity.startsWith('codex:')) return // only the Codex relay delivers to Codex
    // 2) Poll each joined chat for new peer messages.
    for (const [chat, state] of joined) {
      try {
        const rows = messagesAfter(db, chat, state.seat, state.cursor, { identity: state.identity })
        for (const row of rows) {
          await server.notification({
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
          atomic(db, () => {
            renewConnection(db, identity, 'bridge', connection)
            if (
              !liveMemberships(db, identity, connection).some(
                (r) => r.chat === chat && r.seat === state.seat
              )
            )
              return
            if (row.id > state.cursor) {
              state.cursor = row.id
              setCursor(db, chat, state.seat, row.id) // persist -> lossless across respawn
              setDeliveryCursor(db, chat, identity, 'claude-channel', row.id)
            }
          })
        }
      } catch (err) {
        log(`poll error chat="${chat}": ${err}`)
      }
    }
  } catch (error) {
    log(error.message)
    attachmentError = error.message
  } finally {
    polling = false
  }
}, POLL_MS)

// Presence heartbeat for every joined chat.
setInterval(() => {
  if (!identity || attachmentError) return
  try {
    renewConnection(db, identity, 'bridge', connection)
  } catch (error) {
    attachmentError = error.message
    log(attachmentError)
  }
}, 5000)

log(`loops started (poll=${POLL_MS}ms)`)

// On a clean quit (Claude terminates the subprocess), release our seats so a
// returning session reclaims them immediately instead of waiting on the stale
// timer. A hard kill (SIGKILL / reaper) can't run this -- those seats free via
// the ~30s presence-stale path instead.
function shutdown() {
  if (identity)
    try {
      detachConnection(db, identity, 'bridge', connection)
    } catch {}
  process.exit(0)
}
server.onclose = shutdown
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
