// chat-db.mjs -- SQLite data layer for the multi-chat session-chat bridge.
// Uses Node's built-in node:sqlite (DatabaseSync). One shared file backs every
// chat and seat. All queries are parameterized. Multi-chat: every row is keyed
// by a `chat` name so one file holds many independent chats.
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat            TEXT NOT NULL,
  seat            TEXT NOT NULL,
  sender_identity TEXT,
  to_seat         TEXT,
  to_identity     TEXT,
  type            TEXT NOT NULL DEFAULT 'msg',   -- msg | artifact | system
  body            TEXT,
  ref             TEXT,
  summary         TEXT,
  ts              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat, id);

CREATE TABLE IF NOT EXISTS seats (
  chat      TEXT NOT NULL,
  seat      TEXT NOT NULL,
  identity  TEXT,
  joined_ts TEXT,
  PRIMARY KEY (chat, seat)
);

CREATE TABLE IF NOT EXISTS cursors (
  chat         TEXT NOT NULL,
  seat         TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat, seat)
);

CREATE TABLE IF NOT EXISTS presence (
  chat            TEXT NOT NULL,
  seat            TEXT NOT NULL,
  last_seen_epoch INTEGER NOT NULL,
  PRIMARY KEY (chat, seat)
);

CREATE TABLE IF NOT EXISTS chat_renames (
  old_name TEXT PRIMARY KEY,
  new_name TEXT NOT NULL,
  ts       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_cursors (
  chat         TEXT NOT NULL,
  identity     TEXT NOT NULL,
  consumer     TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat, identity, consumer)
);
`

export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 4000;')
  // Set the lock wait before WAL negotiation: several MCP bridges can start and
  // auto-join the same room within the same millisecond.
  db.exec('PRAGMA journal_mode = WAL;') // better concurrent read/write across processes
  db.exec(SCHEMA)

  // CREATE TABLE IF NOT EXISTS does not add columns to an existing database.
  // These additive migrations preserve every old row as a broadcast: a NULL
  // to_identity means the message is visible to all seats in its chat.
  const messageColumns = new Set(
    db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name)
  )
  for (const column of ['sender_identity', 'to_seat', 'to_identity']) {
    if (!messageColumns.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT;`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_to_id ON messages(chat, to_identity, id);')
  return db
}

const AUTO_SEATS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

/**
 * Claim a seat in a chat, atomically, with live-vs-dead collision handling.
 *
 * A seat name is one of three states for THIS caller:
 *   free  -- not in the seats table
 *   mine  -- held by this same identity (a re-join; keeps cursor)
 *   dead  -- held by ANOTHER identity whose presence is stale (session gone) -> reclaimable
 *   live  -- held by ANOTHER identity with a fresh heartbeat -> skip
 *
 * - Labeled seat (e.g. "frontend"): try "frontend", then "frontend-2", "frontend-3", ...
 *   taking the first that is free/mine/dead. So a dead "frontend" is reclaimed; a LIVE
 *   "frontend" pushes you to "frontend-2".
 * - No label: auto-assign first free/dead seat from a-h.
 * Taking over a free/dead seat resets that seat's cursor+presence (start caught-up).
 * Returns the claimed seat name, or null if none available.
 */
export function claimSeat(db, chat, requested, identity, { staleSec = 30 } = {}) {
  db.exec('BEGIN IMMEDIATE;')
  try {
    const rows = db
      .prepare(
        `SELECT s.seat, s.identity, p.last_seen_epoch AS last
           FROM seats s LEFT JOIN presence p ON p.chat = s.chat AND p.seat = s.seat
          WHERE s.chat = :chat`
      )
      .all({ chat })
    const held = new Map(rows.map((r) => [r.seat, { identity: r.identity, last: r.last || 0 }]))
    const cutoff = Date.now() - staleSec * 1000
    const status = (name) => {
      const h = held.get(name)
      if (!h) return 'free'
      if (h.identity === identity) return 'mine'
      return h.last >= cutoff ? 'live' : 'dead'
    }
    const take = (name, st) => {
      if (st === 'free' || st === 'dead') {
        db.prepare('DELETE FROM cursors WHERE chat = :chat AND seat = :seat').run({ chat, seat: name })
      }
      db.prepare(
        `INSERT INTO seats (chat, seat, identity, joined_ts) VALUES (:chat, :seat, :identity, :ts)
         ON CONFLICT(chat, seat) DO UPDATE SET identity = :identity`
      ).run({ chat, seat: name, identity, ts: new Date().toISOString() })
      // Mark the seat LIVE immediately, so a concurrent joiner cannot steal it in
      // the window before the heartbeat loop's first beat (otherwise a just-claimed
      // seat with no presence row reads as "dead" and is reclaimable).
      db.prepare(
        `INSERT INTO presence (chat, seat, last_seen_epoch) VALUES (:chat, :seat, :epoch)
         ON CONFLICT(chat, seat) DO UPDATE SET last_seen_epoch = :epoch`
      ).run({ chat, seat: name, epoch: Date.now() })
      db.exec('COMMIT;')
      return name
    }

    const candidates = requested
      ? [requested, ...Array.from({ length: 19 }, (_, i) => `${requested}-${i + 2}`)]
      : AUTO_SEATS
    for (const c of candidates) {
      const st = status(c)
      if (st === 'free' || st === 'mine' || st === 'dead') return take(c, st)
    }
    db.exec('ROLLBACK;')
    return null
  } catch (e) {
    try { db.exec('ROLLBACK;') } catch {}
    throw e
  }
}

export function releaseSeat(db, chat, seat) {
  db.prepare('DELETE FROM seats WHERE chat = :chat AND seat = :seat').run({ chat, seat })
  db.prepare('DELETE FROM cursors WHERE chat = :chat AND seat = :seat').run({ chat, seat })
  db.prepare('DELETE FROM presence WHERE chat = :chat AND seat = :seat').run({ chat, seat })
}

export function listSeats(db, chat) {
  return db.prepare('SELECT seat, identity FROM seats WHERE chat = :chat ORDER BY seat').all({ chat })
}

/** Every room/seat currently owned by one durable agent-session identity. */
export function listIdentityMemberships(db, identity) {
  return db
    .prepare(
      `SELECT s.chat, s.seat, s.identity, s.joined_ts, p.last_seen_epoch
         FROM seats s
         LEFT JOIN presence p ON p.chat = s.chat AND p.seat = s.seat
        WHERE s.identity = :identity
        ORDER BY s.chat, s.joined_ts DESC, s.seat`
    )
    .all({ identity })
}

/**
 * Replace a provisional process identity with a durable agent-session identity.
 * This is used when a Codex launcher learns the thread UUID after the MCP bridge
 * has already started. Direct-message ownership and delivery cursors move with it.
 */
export function migrateIdentity(db, chat, seat, oldIdentity, newIdentity) {
  if (!oldIdentity || !newIdentity || oldIdentity === newIdentity) return
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(
      `UPDATE seats SET identity = :newIdentity
        WHERE chat = :chat AND seat = :seat AND identity = :oldIdentity`
    ).run({ chat, seat, oldIdentity, newIdentity })
    db.prepare(
      `UPDATE messages SET sender_identity = :newIdentity
        WHERE chat = :chat AND sender_identity = :oldIdentity`
    ).run({ chat, oldIdentity, newIdentity })
    db.prepare(
      `UPDATE messages SET to_identity = :newIdentity
        WHERE chat = :chat AND to_identity = :oldIdentity`
    ).run({ chat, oldIdentity, newIdentity })
    const cursors = db.prepare(
      `SELECT consumer, last_read_id FROM delivery_cursors
        WHERE chat = :chat AND identity = :oldIdentity`
    ).all({ chat, oldIdentity })
    for (const cursor of cursors) {
      db.prepare(
        `INSERT INTO delivery_cursors (chat, identity, consumer, last_read_id)
         VALUES (:chat, :newIdentity, :consumer, :lastReadId)
         ON CONFLICT(chat, identity, consumer) DO UPDATE SET
           last_read_id = MAX(last_read_id, excluded.last_read_id)`
      ).run({
        chat,
        newIdentity,
        consumer: cursor.consumer,
        lastReadId: cursor.last_read_id,
      })
    }
    db.prepare(
      'DELETE FROM delivery_cursors WHERE chat = :chat AND identity = :oldIdentity'
    ).run({ chat, oldIdentity })
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch {}
    throw error
  }
}

export function knownChats(db) {
  return db
    .prepare('SELECT DISTINCT chat FROM seats UNION SELECT DISTINCT chat FROM messages ORDER BY chat')
    .all()
    .map((r) => r.chat)
}

/** Rename a chat: move all rows to newName and record the rename durably (atomic). */
export function migrateChat(db, oldName, newName) {
  db.exec('BEGIN IMMEDIATE;')
  try {
    for (const t of ['messages', 'seats', 'cursors', 'presence', 'delivery_cursors']) {
      db.prepare(`UPDATE ${t} SET chat = :new WHERE chat = :old`).run({ new: newName, old: oldName })
    }
    db.prepare(
      `INSERT INTO chat_renames (old_name, new_name, ts) VALUES (:old, :new, :ts)
       ON CONFLICT(old_name) DO UPDATE SET new_name = :new, ts = :ts`
    ).run({ old: oldName, new: newName, ts: new Date().toISOString() })
    db.exec('COMMIT;')
  } catch (e) {
    try { db.exec('ROLLBACK;') } catch {}
    throw e
  }
}

/** Follow the rename chain for `name` to its final current name (or `name` if none). */
export function resolveRename(db, name) {
  const seen = new Set()
  let cur = name
  while (!seen.has(cur)) {
    seen.add(cur)
    const row = db.prepare('SELECT new_name FROM chat_renames WHERE old_name = :c').get({ c: cur })
    if (!row) break
    cur = row.new_name
  }
  return cur
}

export function sendMessage(
  db,
  chat,
  seat,
  body,
  { senderIdentity = null, toSeat = null, toIdentity = null } = {}
) {
  if ((toSeat === null) !== (toIdentity === null)) {
    throw new Error('direct messages require both toSeat and toIdentity')
  }
  const res = db
    .prepare(
      `INSERT INTO messages
         (chat, seat, sender_identity, to_seat, to_identity, type, body, ts)
       VALUES
         (:chat, :seat, :senderIdentity, :toSeat, :toIdentity, 'msg', :body, :ts)`
    )
    .run({ chat, seat, senderIdentity, toSeat, toIdentity, body, ts: new Date().toISOString() })
  return Number(res.lastInsertRowid)
}

/** Insert a historical message with an EXPLICIT timestamp (used by the importer). */
export function importMessage(db, chat, seat, body, ts) {
  const res = db
    .prepare(
      `INSERT INTO messages (chat, seat, type, body, ts)
       VALUES (:chat, :seat, 'msg', :body, :ts)`
    )
    .run({ chat, seat, body, ts })
  return Number(res.lastInsertRowid)
}

/**
 * New peer messages visible to this session: broadcasts plus messages addressed
 * to its stable identity. The identity check prevents a replacement session that
 * reuses the same display seat from receiving an earlier session's direct mail.
 */
export function messagesAfter(db, chat, seat, lastId, { identity = null } = {}) {
  return db
    .prepare(
      `SELECT id, chat, seat, sender_identity, to_seat, to_identity,
              type, body, ref, summary, ts
         FROM messages
        WHERE chat = :chat
          AND id > :lastId
          AND seat != :seat
          AND (to_identity IS NULL OR to_identity = :identity)
        ORDER BY id ASC`
    )
    .all({ chat, seat, identity, lastId })
}

/**
 * Windowed history for catch-up. When viewerIdentity is supplied, direct messages
 * between other sessions are omitted. Administrative callers may omit it to read all.
 */
export function history(db, chat, { limit = 30, beforeId, viewerIdentity } = {}) {
  const visibility = viewerIdentity === undefined
    ? ''
    : ` AND (to_identity IS NULL
             OR sender_identity = :viewerIdentity
             OR to_identity = :viewerIdentity)`
  const params = { chat, limit }
  if (beforeId !== undefined) params.beforeId = beforeId
  if (viewerIdentity !== undefined) params.viewerIdentity = viewerIdentity
  const rows = beforeId
    ? db
        .prepare(
          `SELECT id, chat, seat, sender_identity, to_seat, to_identity,
                  type, body, ref, summary, ts
             FROM messages
            WHERE chat = :chat AND id < :beforeId${visibility}
            ORDER BY id DESC LIMIT :limit`
        )
        .all(params)
    : db
        .prepare(
          `SELECT id, chat, seat, sender_identity, to_seat, to_identity,
                  type, body, ref, summary, ts
             FROM messages
            WHERE chat = :chat${visibility}
            ORDER BY id DESC LIMIT :limit`
        )
        .all(params)
  return rows.reverse()
}

export function maxId(db, chat) {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE chat = :chat').get({ chat })
  return Number(row.m)
}

export function getCursor(db, chat, seat) {
  const row = db
    .prepare('SELECT last_read_id FROM cursors WHERE chat = :chat AND seat = :seat')
    .get({ chat, seat })
  return row ? Number(row.last_read_id) : null
}

export function setCursor(db, chat, seat, id) {
  db.prepare(
    `INSERT INTO cursors (chat, seat, last_read_id) VALUES (:chat, :seat, :id)
     ON CONFLICT(chat, seat) DO UPDATE SET last_read_id = :id`
  ).run({ chat, seat, id })
}

/** Independent durable cursor for non-MCP delivery consumers such as the Codex relay. */
export function getDeliveryCursor(db, chat, identity, consumer) {
  const row = db
    .prepare(
      `SELECT last_read_id FROM delivery_cursors
        WHERE chat = :chat AND identity = :identity AND consumer = :consumer`
    )
    .get({ chat, identity, consumer })
  return row ? Number(row.last_read_id) : null
}

export function setDeliveryCursor(db, chat, identity, consumer, id) {
  db.prepare(
    `INSERT INTO delivery_cursors (chat, identity, consumer, last_read_id)
     VALUES (:chat, :identity, :consumer, :id)
     ON CONFLICT(chat, identity, consumer) DO UPDATE SET last_read_id = :id`
  ).run({ chat, identity, consumer, id })
}

export function deleteDeliveryCursor(db, chat, identity, consumer) {
  db.prepare(
    `DELETE FROM delivery_cursors
      WHERE chat = :chat AND identity = :identity AND consumer = :consumer`
  ).run({ chat, identity, consumer })
}

export function heartbeat(db, chat, seat, epoch) {
  db.prepare(
    `INSERT INTO presence (chat, seat, last_seen_epoch) VALUES (:chat, :seat, :epoch)
     ON CONFLICT(chat, seat) DO UPDATE SET last_seen_epoch = :epoch`
  ).run({ chat, seat, epoch })
}

export function whoOnline(db, chat, windowSec = 10) {
  const cutoff = Date.now() - windowSec * 1000
  return db
    .prepare('SELECT seat, last_seen_epoch FROM presence WHERE chat = :chat AND last_seen_epoch >= :cutoff ORDER BY seat')
    .all({ chat, cutoff })
    .map((r) => r.seat)
}
