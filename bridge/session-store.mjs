// Durable subscriptions and fenced live connections. All ownership changes use
// SQLite write transactions so concurrent bridge processes cannot both win.
import { randomUUID } from 'node:crypto'
import { maxId, setCursor, setDeliveryCursor, getDeliveryCursor } from './chat-db.mjs'

export const LEASE_MS = 30_000
export const durable = (identity) => /^(codex|claude):.+/.test(identity || '')
export function atomic(db, fn) {
  const savepoint = `s_${randomUUID().replaceAll('-', '')}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result = fn()
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    throw error
  }
}

export function claimConnection(db, identity, role, connection, now = Date.now(), binding = null) {
  // BEGIN IMMEDIATE serializes the initial read-and-claim, including empty DBs.
  db.exec('BEGIN IMMEDIATE')
  try {
    const held = db
      .prepare('SELECT * FROM connection_leases WHERE identity=? AND role=?')
      .get(identity, role)
    if (held && held.expires_at > now && held.connection_id !== connection) {
      throw new Error(
        `Session ${identity} already has a live ${role} connection. Close it before resuming here.`
      )
    }
    const partner = db
      .prepare(
        `SELECT binding_id FROM connection_leases
      WHERE identity=? AND role<>? AND expires_at>?`
      )
      .get(identity, role, now)
    if (partner && partner.binding_id !== binding) {
      throw new Error(
        `Session ${identity} is attached through another launcher; close it before resuming here.`
      )
    }
    if (
      role === 'bridge' &&
      !held &&
      db
        .prepare(
          `SELECT 1 FROM seats s JOIN presence p USING(chat,seat)
      WHERE s.identity=? AND s.connection_id IS NULL AND p.last_seen_epoch>?`
        )
        .get(identity, now - LEASE_MS)
    ) {
      throw new Error(
        `Session ${identity} has a live legacy bridge. Close that session before reconnecting.`
      )
    }
    db.prepare(
      `INSERT INTO connection_leases(identity,role,connection_id,expires_at,binding_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(identity,role) DO UPDATE SET connection_id=excluded.connection_id, expires_at=excluded.expires_at, binding_id=excluded.binding_id`
    ).run(identity, role, connection, now + LEASE_MS, binding)
    if (role === 'bridge') {
      // Retire stale live rows only. Subscriptions and identity cursors survive.
      const rows = db
        .prepare('SELECT chat,seat FROM seats WHERE identity=? AND connection_id IS NOT ?')
        .all(identity, connection)
      for (const row of rows) removeLiveSeat(db, row.chat, row.seat)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function assertConnection(db, identity, role, connection, now = Date.now()) {
  const row = db
    .prepare(
      `SELECT 1 FROM connection_leases
    WHERE identity=? AND role=? AND connection_id=? AND expires_at>?`
    )
    .get(identity, role, connection, now)
  if (!row) throw new Error(`Lost ${role} connection lease for ${identity}; reconnect Intercom.`)
}

export function renewConnection(db, identity, role, connection, now = Date.now()) {
  const result = db
    .prepare(
      `UPDATE connection_leases SET expires_at=?
    WHERE identity=? AND role=? AND connection_id=? AND expires_at>?`
    )
    .run(now + LEASE_MS, identity, role, connection, now)
  if (!result.changes)
    throw new Error(`Lost ${role} connection lease for ${identity}; reconnect Intercom.`)
  if (role === 'bridge')
    db.prepare(
      `UPDATE presence SET last_seen_epoch=? WHERE (chat,seat) IN
    (SELECT chat,seat FROM seats WHERE identity=? AND connection_id=?)`
    ).run(now, identity, connection)
}

function removeLiveSeat(db, chat, seat) {
  db.prepare('DELETE FROM seats WHERE chat=? AND seat=?').run(chat, seat)
  db.prepare('DELETE FROM presence WHERE chat=? AND seat=?').run(chat, seat)
  db.prepare('DELETE FROM cursors WHERE chat=? AND seat=?').run(chat, seat)
}

export function detachConnection(db, identity, role, connection) {
  return atomic(db, () => {
    const result = db
      .prepare('DELETE FROM connection_leases WHERE identity=? AND role=? AND connection_id=?')
      .run(identity, role, connection)
    if (!result.changes || role !== 'bridge') return
    for (const row of db
      .prepare('SELECT chat,seat FROM seats WHERE identity=? AND connection_id=?')
      .all(identity, connection)) {
      removeLiveSeat(db, row.chat, row.seat)
    }
  })
}

export function subscriptions(db, identity) {
  return db
    .prepare('SELECT chat,seat FROM subscriptions WHERE identity=? ORDER BY chat')
    .all(identity)
}

export function liveMemberships(db, identity, connection) {
  return db
    .prepare('SELECT chat,seat FROM seats WHERE identity=? AND connection_id=? ORDER BY chat')
    .all(identity, connection)
}

export function joinRoom(db, identity, connection, chat, requested, { restoring = false } = {}) {
  return atomic(db, () => {
    // Acquire SQLite write lock before validating ownership.
    renewConnection(db, identity, 'bridge', connection)
    if (typeof chat !== 'string' || !chat.trim()) throw new Error('Room name must not be empty')
    const saved = db
      .prepare('SELECT seat FROM subscriptions WHERE identity=? AND chat=?')
      .get(identity, chat)
    const preferred = requested || saved?.seat
    const strict = restoring || (Boolean(saved) && (!requested || requested === saved.seat))
    const candidates = preferred
      ? [
          preferred,
          ...(strict ? [] : Array.from({ length: 19 }, (_, i) => `${preferred}-${i + 2}`)),
        ]
      : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const available = (seat) => {
      const held = db
        .prepare(
          `SELECT s.*, p.last_seen_epoch, l.expires_at
        FROM seats s LEFT JOIN presence p USING(chat,seat)
        LEFT JOIN connection_leases l ON l.identity=s.identity AND l.role='bridge' AND l.connection_id=s.connection_id
        WHERE s.chat=? AND s.seat=?`
        )
        .get(chat, seat)
      return (
        !held ||
        held.identity === identity ||
        (held.connection_id
          ? (held.expires_at || 0) <= Date.now()
          : (held.last_seen_epoch || 0) < Date.now() - LEASE_MS)
      )
    }
    const assigned = candidates.find(available)
    if (!assigned)
      throw new Error(
        `Room ${chat}: saved/requested seat "${preferred || '(auto)'}" is occupied; choose a name explicitly. No identity was transferred.`
      )
    for (const row of db
      .prepare('SELECT seat FROM seats WHERE chat=? AND identity=?')
      .all(chat, identity)) {
      if (row.seat !== assigned) removeLiveSeat(db, chat, row.seat)
    }
    removeLiveSeat(db, chat, assigned)
    db.prepare(
      'INSERT INTO seats(chat,seat,identity,joined_ts,connection_id) VALUES (?,?,?,?,?)'
    ).run(chat, assigned, identity, new Date().toISOString(), connection)
    db.prepare('INSERT INTO presence VALUES (?,?,?)').run(chat, assigned, Date.now())
    if (durable(identity))
      db.prepare(
        `INSERT INTO subscriptions VALUES (?,?,?)
      ON CONFLICT(identity,chat) DO UPDATE SET seat=excluded.seat`
      ).run(identity, chat, assigned)
    for (const consumer of ['claude-channel', 'codex-app-server']) {
      if (getDeliveryCursor(db, chat, identity, consumer) === null) {
        setDeliveryCursor(db, chat, identity, consumer, maxId(db, chat))
      }
    }
    setCursor(db, chat, assigned, getDeliveryCursor(db, chat, identity, 'claude-channel'))
    return assigned
  })
}

export function attachRooms(db, identity, connection, startupChat, seat) {
  return atomic(db, () => {
    renewConnection(db, identity, 'bridge', connection)
    const known = db.prepare('SELECT 1 FROM session_records WHERE identity=?').get(identity)
    const conflicts = []
    if (known) {
      for (const saved of subscriptions(db, identity)) {
        try {
          joinRoom(db, identity, connection, saved.chat, saved.seat, { restoring: true })
        } catch (error) {
          conflicts.push(error.message)
        }
      }
    } else {
      if (startupChat) joinRoom(db, identity, connection, startupChat, seat)
      if (durable(identity))
        db.prepare('INSERT INTO session_records VALUES (?,?)').run(identity, Date.now())
    }
    return conflicts
  })
}

export function leaveRoom(db, identity, connection, chat) {
  return atomic(db, () => {
    renewConnection(db, identity, 'bridge', connection)
    for (const row of db
      .prepare('SELECT seat FROM seats WHERE chat=? AND identity=? AND connection_id=?')
      .all(chat, identity, connection)) {
      removeLiveSeat(db, chat, row.seat)
    }
    db.prepare('DELETE FROM subscriptions WHERE identity=? AND chat=?').run(identity, chat)
    db.prepare('DELETE FROM delivery_cursors WHERE identity=? AND chat=?').run(identity, chat)
  })
}
