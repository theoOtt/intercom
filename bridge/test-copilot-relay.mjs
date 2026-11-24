import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, sendMessage, getDeliveryCursor } from './chat-db.mjs'
import { claimConnection, attachRooms, joinRoom, leaveRoom } from './session-store.mjs'
import { CopilotRelay } from './copilot-relay.mjs'

const temp = mkdtempSync(join(tmpdir(), 'intercom-copilot-relay-'))
const db = openDb(join(temp, 'chat.db'))
const identity = 'copilot:test-conversation'
claimConnection(db, identity, 'bridge', 'bridge')
attachRooms(db, identity, 'bridge', 'room', 'Copilot')
const sent = []
const warnings = []
let send = async (message) => { sent.push(message); return `accepted-${sent.length}` }
const relay = new CopilotRelay({ db, identity, send: (message) => send(message), log: (message) => warnings.push(message) })
const peer = (chat, body, toIdentity = null) =>
  sendMessage(db, chat, 'peer', body, { senderIdentity: 'claude:peer', toIdentity, toSeat: toIdentity ? 'Copilot' : null })
try {
  peer('room', 'not for Copilot', 'copilot:different-conversation')
  const direct = peer('room', 'direct to Copilot', identity)
  peer('room', 'broadcast')
  await relay.tick()
  await relay.tick()
  await relay.tick()
  assert.equal(sent.length, 2)
  assert(sent[0].prompt.includes('direct to Copilot'))
  assert(sent[1].prompt.includes('broadcast'))
  assert(sent.every((message) => message.mode === 'immediate' && message.prompt.includes('not user authorization')))
  assert.equal(db.prepare('SELECT state FROM delivery_receipts WHERE identity=? AND message_id=?').get(identity, direct).state, 'accepted')
  console.log('PASS: native delivery preserves order, direct-message isolation, and no duplicates')

  const uncertain = peer('room', 'ambiguous submission', identity)
  send = async () => { throw new Error('transport disconnected after write') }
  await relay.tick()
  await relay.tick()
  assert.equal(db.prepare('SELECT state FROM delivery_receipts WHERE identity=? AND message_id=?').get(identity, uncertain).state, 'uncertain')
  assert.equal(warnings.length, 1)
  joinRoom(db, identity, 'bridge', 'other-room', 'Copilot')
  peer('other-room', 'independent room', identity)
  send = async (message) => { sent.push(message); return 'other-accepted' }
  await relay.tick()
  assert.equal(sent.length, 3)
  console.log('PASS: ambiguous acceptance is quarantined without blocking independent rooms')

  joinRoom(db, identity, 'bridge', 'leaving-room', 'Copilot')
  peer('leaving-room', 'leave during delivery', identity)
  send = async () => {
    leaveRoom(db, identity, 'bridge', 'leaving-room')
    return 'accepted-before-leave'
  }
  await relay.tick()
  assert.equal(getDeliveryCursor(db, 'leaving-room', identity, 'copilot-sdk'), null)
  console.log('PASS: an in-flight delivery cannot resurrect a room left by the user')

  await relay.stop()
  const restored = new CopilotRelay({
    db, identity, send: async () => { throw new Error('must not resend') }, log: () => {},
  })
  await restored.tick()
  await restored.stop()
  assert.equal(sent.length, 3)
  console.log('PASS: reconnect does not replay accepted or uncertain submissions')

  joinRoom(db, identity, 'bridge', 'fenced-room', 'Copilot')
  const fencedMessage = peer('fenced-room', 'lease lost during delivery', identity)
  const fenced = new CopilotRelay({
    db, identity, log: () => {},
    send: async () => {
      db.prepare("UPDATE connection_leases SET expires_at=0 WHERE identity=? AND role='relay'").run(identity)
      throw new Error('transport disconnected')
    },
  })
  await assert.rejects(fenced.tick(), /Lost relay connection lease/)
  assert.equal(db.prepare('SELECT state FROM delivery_receipts WHERE identity=? AND message_id=?')
    .get(identity, fencedMessage).state, 'submitting')
  await fenced.stop()
  console.log('PASS: a stale relay cannot overwrite a delivery receipt after losing ownership')
} finally {
  await relay.stop()
  db.close()
  rmSync(temp, { recursive: true, force: true })
}
