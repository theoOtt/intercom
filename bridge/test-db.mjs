// test-db.mjs -- headless assertions for the multi-chat data layer (no Claude).
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  openDb, claimSeat, releaseSeat, listSeats, knownChats,
  migrateIdentity,
  sendMessage, messagesAfter, history, maxId,
  getCursor, setCursor, getDeliveryCursor, setDeliveryCursor, heartbeat, whoOnline,
  migrateChat, resolveRename,
} from './chat-db.mjs'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS: ${msg}`) } else { fail++; console.log(`FAIL: ${msg}`) } }

const path = join(tmpdir(), `test-chat-${Date.now()}.db`)
console.log('temp db:', path)
const db = openDb(path)

try {
  // --- seat auto-assignment ---
  ok(claimSeat(db, 'x', null, 'id1') === 'a', 'auto-seat #1 in chat x -> "a"')
  ok(claimSeat(db, 'x', null, 'id2') === 'b', 'auto-seat #2 in chat x -> "b" (different seat)')
  ok(claimSeat(db, 'x', 'a', 'id1') === 'a', 're-claim seat "a" with SAME identity is idempotent -> "a"')
  ok(claimSeat(db, 'x', 'a', 'id3') === 'a-2', 'claim LIVE seat "a" (labeled, diff identity) -> suffix "a-2"')

  // fill chat y to capacity (a-h = 8 seats) then overflow
  const yseats = []
  for (let i = 0; i < 8; i++) yseats.push(claimSeat(db, 'y', null, `y-id-${i}`))
  ok(yseats.every(Boolean) && new Set(yseats).size === 8, 'chat y filled with 8 distinct seats')
  ok(claimSeat(db, 'y', null, 'y-id-overflow') === null, '9th join to full chat y -> null')

  // --- named-seat collision: live incumbent -> suffix; dead incumbent -> reclaim ---
  ok(claimSeat(db, 'col', 'frontend', 'idF') === 'frontend', 'named seat "frontend" claimed')
  heartbeat(db, 'col', 'frontend', Date.now()) // frontend is LIVE
  ok(claimSeat(db, 'col', 'frontend', 'idG') === 'frontend-2', 'live "frontend" collision -> "frontend-2"')
  heartbeat(db, 'col', 'frontend', Date.now() - 60_000) // frontend now STALE (session gone)
  ok(claimSeat(db, 'col', 'frontend', 'idH') === 'frontend', 'stale "frontend" -> reclaimed as "frontend" (not -3)')
  ok(claimSeat(db, 'col', 'frontend', 'idH') === 'frontend', 're-join same identity -> same seat (reconnect)')

  // --- multi-chat isolation + peers-only ---
  const idA = sendMessage(db, 'x', 'a', 'hello from a in x', { senderIdentity: 'id1' })
  ok(idA > 0, 'sendMessage in chat x returns id')
  ok(messagesAfter(db, 'y', 'a', 0).length === 0, 'chat y sees NONE of chat x messages (isolation)')
  ok(messagesAfter(db, 'x', 'b', 0, { identity: 'id2' }).length === 1, 'seat b in x sees a\'s message (peer)')
  ok(messagesAfter(db, 'x', 'a', 0, { identity: 'id1' }).length === 0, 'seat a in x does NOT see its own message')

  const idB = sendMessage(db, 'x', 'b', 'reply from b', { senderIdentity: 'id2' })
  ok(idB > idA, 'second send gets higher id')
  ok(messagesAfter(db, 'x', 'a', idA, { identity: 'id1' }).length === 1 &&
     messagesAfter(db, 'x', 'a', idA, { identity: 'id1' })[0].seat === 'b',
     'after cursor=idA, seat a sees only b\'s new message')
  ok(maxId(db, 'x') === idB && maxId(db, 'y') === 0, 'maxId is per-chat')

  // --- directed delivery + stable identity isolation ---
  const directToB = sendMessage(db, 'x', 'a', 'only b', {
    senderIdentity: 'id1', toSeat: 'b', toIdentity: 'id2',
  })
  ok(messagesAfter(db, 'x', 'b', idB, { identity: 'id2' }).map((m) => m.id).includes(directToB),
     'direct recipient receives its message')
  ok(messagesAfter(db, 'x', 'a-2', idB, { identity: 'id3' }).length === 0,
     'other seats ignore a directed message')
  ok(messagesAfter(db, 'x', 'b', idB, { identity: 'replacement-id' }).length === 0,
     'a replacement identity reusing the recipient seat cannot read old direct mail')
  const historyForB = history(db, 'x', { limit: 20, viewerIdentity: 'id2' })
  const historyForOther = history(db, 'x', { limit: 20, viewerIdentity: 'id3' })
  ok(historyForB.some((m) => m.id === directToB), 'recipient sees direct message in history')
  ok(!historyForOther.some((m) => m.id === directToB), 'direct message is hidden from other histories')
  ok(history(db, 'x', { limit: 20 }).some((m) => m.id === directToB),
     'administrative history can inspect all messages')

  migrateIdentity(db, 'x', 'b', 'id2', 'codex:thread-b')
  ok(listSeats(db, 'x').find((s) => s.seat === 'b')?.identity === 'codex:thread-b',
     'provisional identity migrates to durable session identity')
  ok(messagesAfter(db, 'x', 'b', idB, { identity: 'codex:thread-b' }).some((m) => m.id === directToB),
     'direct messages follow a session identity migration')

  // --- cursor persistence ---
  setCursor(db, 'x', 'a', idB)
  ok(getCursor(db, 'x', 'a') === idB, 'cursor persists via setCursor/getCursor')
  ok(getCursor(db, 'x', 'zzz') === null, 'unknown cursor returns null')
  setDeliveryCursor(db, 'x', 'codex:thread-b', 'codex-relay', directToB)
  ok(getDeliveryCursor(db, 'x', 'codex:thread-b', 'codex-relay') === directToB,
     'independent delivery cursor persists per identity and consumer')

  // --- history windowing ---
  for (let i = 0; i < 5; i++) sendMessage(db, 'h', 'a', `msg ${i}`)
  const recent = history(db, 'h', { limit: 3 })
  ok(recent.length === 3 && recent[0].id < recent[2].id, 'history limit=3 returns 3, chronological')
  const older = history(db, 'h', { limit: 10, beforeId: recent[0].id })
  ok(older.every((r) => r.id < recent[0].id), 'history before_id pages strictly older')

  // --- presence window ---
  heartbeat(db, 'x', 'a', Date.now())
  heartbeat(db, 'x', 'b', Date.now() - 30_000) // stale
  const online = whoOnline(db, 'x', 10)
  ok(online.includes('a') && !online.includes('b'), 'whoOnline: fresh seat online, stale seat not')

  // --- leave frees seat ---
  releaseSeat(db, 'x', 'a')
  ok(!listSeats(db, 'x').some((s) => s.seat === 'a'), 'releaseSeat removes the seat')
  ok(claimSeat(db, 'x', null, 'id-new') === 'a', 'freed seat "a" is reclaimable')

  ok(new Set(knownChats(db)).size >= 3, 'knownChats lists all chats (x, y, h)')

  // --- rename: data migrates, seats/cursors follow, resolveRename follows the chain ---
  sendMessage(db, 'oldname', 'a', 'hi in oldname')
  claimSeat(db, 'oldname', 'frontend', 'idR')
  setCursor(db, 'oldname', 'frontend', 7)
  migrateChat(db, 'oldname', 'newname')
  ok(maxId(db, 'oldname') === 0, 'after rename, oldname has no messages')
  ok(history(db, 'newname', { limit: 10 }).some((r) => r.body === 'hi in oldname'), 'messages moved to newname')
  ok(listSeats(db, 'newname').some((s) => s.seat === 'frontend'), 'seats moved to newname')
  ok(getCursor(db, 'newname', 'frontend') === 7, 'cursor moved to newname')
  ok(resolveRename(db, 'oldname') === 'newname', 'resolveRename: oldname -> newname')
  migrateChat(db, 'newname', 'finalname')
  ok(resolveRename(db, 'oldname') === 'finalname', 'resolveRename follows chain oldname -> newname -> finalname')
  ok(resolveRename(db, 'never-renamed') === 'never-renamed', 'resolveRename returns same name when no rename')

  // --- additive migration from the original broadcast-only schema ---
  const legacyPath = join(tmpdir(), `test-chat-legacy-${Date.now()}.db`)
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, seat TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'msg', body TEXT, ref TEXT, summary TEXT, ts TEXT NOT NULL
    );
    INSERT INTO messages (chat, seat, body, ts) VALUES ('legacy', 'a', 'old broadcast', '2026-01-01T00:00:00Z');
  `)
  legacy.close()
  const migrated = openDb(legacyPath)
  const migratedColumns = migrated.prepare('PRAGMA table_info(messages)').all().map((column) => column.name)
  ok(['sender_identity', 'to_seat', 'to_identity'].every((column) => migratedColumns.includes(column)),
     'openDb adds directed-message columns to a legacy database')
  ok(history(migrated, 'legacy', { viewerIdentity: 'new-session' })[0]?.body === 'old broadcast',
     'legacy rows remain broadcasts after migration')
  migrated.close()
  rmSync(legacyPath, { force: true })
  rmSync(`${legacyPath}-wal`, { force: true })
  rmSync(`${legacyPath}-shm`, { force: true })
} finally {
  try { rmSync(path); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true }) } catch {}
  console.log(`\ncleaned up ${path}`)
}

console.log(`\nResults: ${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
