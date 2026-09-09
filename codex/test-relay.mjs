// Isolated relay test: fake App Server, real SQLite schema and identity migration.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexRelay } from './relay.mjs'
import { claimConnection, attachRooms, joinRoom, leaveRoom, detachConnection } from '../bridge/session-store.mjs'
import {
  openDb,
  claimSeat,
  releaseSeat,
  sendMessage,
  history,
  maxId,
  getDeliveryCursor,
  setDeliveryCursor,
  deleteDeliveryCursor,
  migrateChat,
} from '../bridge/chat-db.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  process.stdout.write(`PASS: ${message}\n`)
}
const waitFor = async (condition, message) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(`FAIL: timed out waiting for ${message}`)
}
const turnText = (turn) => turn.input.find((item) => item.type === 'text')?.text || ''
class FakeAppServer extends EventEmitter {
  constructor(threadId) {
    super()
    this.threadId = threadId
    this.turns = []
    this.handler = null
    this.status = 'idle'
    this.activeTurn = 'active-turn'
    this.steers = []
    this.rejectNext = false
    this.ambiguous = false
    this.startRace = false
  }
  setServerRequestHandler(handler) { this.handler = handler }
  async connect() {}
  close() {}
  async request(method, params) {
    if (method === 'thread/loaded/list') return { data: [this.threadId], nextCursor: null }
    if (method === 'thread/read') return { thread: { id: this.threadId, status: { type: this.status } } }
    if (method === 'thread/turns/list') return { data: [{ id: this.activeTurn, status: 'inProgress' }] }
    if (method === 'turn/steer') {
      if (this.rejectNext) {
        this.rejectNext = false
        this.status = 'idle'
        const error = new Error('active turn changed')
        error.code = -32600
        throw error
      }
      if (this.ambiguous) throw new Error('App Server request timed out: turn/steer')
      if (params.expectedTurnId !== this.activeTurn) throw new Error('wrong active turn ID')
      this.steers.push(params)
      return { turnId: this.activeTurn }
    }
    if (method === 'turn/start') {
      if (this.startRace) {
        this.startRace = false
        this.status = 'active'
        const error = new Error('turn already active')
        error.code = -32600
        throw error
      }
      this.turns.push(params)
      return { turn: { id: randomUUID(), status: 'inProgress', items: [] } }
    }
    throw new Error(`unexpected fake request: ${method}`)
  }
}

const temp = mkdtempSync(join(tmpdir(), 'intercom-relay-'))
const dbPath = join(temp, 'chat.db')
const identityFile = join(temp, 'identity')
const provisional = `codex-startup:${randomUUID()}`
const threadId = randomUUID()
const stable = `codex:${threadId}`
writeFileSync(identityFile, `${provisional}\n`)
const db = openDb(dbPath)
claimConnection(db, stable, 'bridge', 'test-bridge', Date.now(), identityFile)
attachRooms(db, stable, 'test-bridge', 'relay-test', 'reviewer')
claimSeat(db, 'relay-test', 'claude', 'claude:sender')
const fake = new FakeAppServer(threadId)
const logs = []
const relay = new CodexRelay({
  endpoint: 'ws://fake',
  dbPath,
  chat: 'relay-test',
  identityFile,
  client: fake,
  skillPath: join(temp, 'missing-skill'),
  pollMs: 10,
  log: (message) => logs.push(message),
})

try {
  const run = relay.start()
  await waitFor(() => logs.some((line) => line.startsWith('attached')), 'relay attachment')
  assert(readFileSync(identityFile, 'utf8').trim() === stable, 'relay adopts Codex thread UUID as durable identity')

  sendMessage(db, 'relay-test', 'claude', 'wake the reviewer', {
    senderIdentity: 'claude:sender',
    toSeat: 'reviewer',
    toIdentity: stable,
  })
  await waitFor(() => fake.turns.length === 1, 'primary-room direct message')
  assert(fake.turns.length === 1, 'direct message starts exactly one Codex turn')
  assert(turnText(fake.turns[0]).includes('wake the reviewer'), 'turn contains peer message body')
  assert(turnText(fake.turns[0]).includes('From seat: claude'), 'turn identifies the sender seat')

  sendMessage(db, 'relay-test', 'claude', 'room broadcast', { senderIdentity: 'claude:sender' })
  await waitFor(() => fake.turns.length === 2, 'primary-room broadcast')
  assert(fake.turns.length === 2, 'broadcast also starts a Codex turn')

  // Simulate a runtime MCP join. The bridge seeds the independent relay cursor
  // at the join boundary before the relay discovers the new membership.
  joinRoom(db, stable, 'test-bridge', 'second-room', 'reviewer-two')
  setDeliveryCursor(db, 'second-room', stable, 'codex-app-server', maxId(db, 'second-room'))
  claimSeat(db, 'second-room', 'claude-two', 'claude:sender-two')
  sendMessage(db, 'second-room', 'claude-two', 'hello from the second room', {
    senderIdentity: 'claude:sender-two',
    toSeat: 'reviewer-two',
    toIdentity: stable,
  })
  await waitFor(() => fake.turns.length === 3, 'runtime-joined room message')
  assert(turnText(fake.turns[2]).includes('Chat: second-room'), 'runtime-joined room identifies its chat')
  assert(turnText(fake.turns[2]).includes('hello from the second room'), 'runtime-joined room wakes Codex')

  sendMessage(db, 'relay-test', 'claude', 'ordered first', { senderIdentity: 'claude:sender' })
  sendMessage(db, 'second-room', 'claude-two', 'ordered second', { senderIdentity: 'claude:sender-two' })
  await waitFor(() => fake.turns.length === 5, 'cross-room ordered messages')
  assert(turnText(fake.turns[3]).includes('ordered first'), 'oldest pending room message is delivered first')
  assert(turnText(fake.turns[4]).includes('ordered second'), 'next room message preserves global order')

  const privateForSomeoneElse = sendMessage(db, 'second-room', 'claude-two', 'not for reviewer', {
    senderIdentity: 'claude:sender-two',
    toSeat: 'someone-else',
    toIdentity: 'codex:someone-else',
  })
  await sleep(80)
  assert(fake.turns.length === 5, 'direct message to another identity is ignored in a secondary room')
  assert(
    !history(db, 'second-room', { viewerIdentity: stable }).some((row) => row.id === privateForSomeoneElse),
    'other direct message is hidden from resumed session history'
  )

  migrateChat(db, 'second-room', 'renamed-room')
  sendMessage(db, 'renamed-room', 'claude-two', 'message after rename', {
    senderIdentity: 'claude:sender-two',
  })
  await waitFor(() => fake.turns.length === 6, 'renamed room message')
  assert(turnText(fake.turns[5]).includes('Chat: renamed-room'), 'renamed room remains watched')

  leaveRoom(db, stable, 'test-bridge', 'renamed-room')
  sendMessage(db, 'renamed-room', 'claude-two', 'message while explicitly absent', {
    senderIdentity: 'claude:sender-two',
  })
  await sleep(80)
  assert(fake.turns.length === 6, 'explicitly left room is no longer watched')

  joinRoom(db, stable, 'test-bridge', 'renamed-room', 'reviewer-returned')
  setDeliveryCursor(db, 'renamed-room', stable, 'codex-app-server', maxId(db, 'renamed-room'))
  sendMessage(db, 'renamed-room', 'claude-two', 'message after rejoin', {
    senderIdentity: 'claude:sender-two',
  })
  await waitFor(() => fake.turns.length === 7, 'rejoined room message')
  assert(turnText(fake.turns[6]).includes('message after rejoin'), 'rejoined room is watched again')
  assert(
    !fake.turns.some((turn) => turnText(turn).includes('message while explicitly absent')),
    'messages sent while explicitly absent are not replayed on rejoin'
  )

  fake.status = 'active'
  const activeId = sendMessage(db, 'renamed-room', 'claude-two', 'important while busy', { senderIdentity: 'claude:sender-two' })
  await waitFor(() => fake.steers.length === 1, 'active steering')
  assert(fake.turns.length === 7, 'busy delivery steers without starting another turn')
  assert(turnText(fake.steers[0]).includes('important while busy'), 'busy Codex receives the peer payload')
  const receipt = db.prepare('SELECT * FROM delivery_receipts WHERE identity=? AND message_id=?').get(stable, activeId)
  assert(receipt.state === 'accepted' && receipt.detail.includes('not independently confirmed'), 'acceptance is not mislabeled as read')

  fake.rejectNext = true
  const racedId = sendMessage(db, 'relay-test', 'claude', 'turn ended during steer', { senderIdentity: 'claude:sender' })
  await waitFor(() => fake.turns.length === 8, 'race fallback to idle turn')
  assert(turnText(fake.turns[7]).includes('turn ended during steer'), 'turn completion race retries from fresh thread state')
  assert(db.prepare('SELECT state FROM delivery_receipts WHERE identity=? AND message_id=?').get(stable, racedId).state === 'accepted', 'race advances cursor only after acceptance')

  fake.startRace = true
  sendMessage(db, 'relay-test', 'claude', 'user started working during delivery', { senderIdentity: 'claude:sender' })
  await waitFor(() => fake.steers.length === 2, 'idle-to-active race')
  assert(fake.turns.length === 8, 'a competing active turn is steered after idle-start rejection')

  fake.status = 'active'
  fake.ambiguous = true
  const beforeUnknown = getDeliveryCursor(db, 'relay-test', stable, 'codex-app-server')
  const unknownId = sendMessage(db, 'relay-test', 'claude', 'ambiguous delivery', { senderIdentity: 'claude:sender' })
  await waitFor(() => db.prepare('SELECT state FROM delivery_receipts WHERE identity=? AND message_id=?').get(stable, unknownId)?.state === 'uncertain', 'uncertain receipt')
  assert(getDeliveryCursor(db, 'relay-test', stable, 'codex-app-server') === beforeUnknown, 'ambiguous delivery preserves cursor for reconciliation')
  await sleep(50)
  assert(fake.steers.length === 2, 'ambiguous delivery is not blindly duplicated')
  relay.stop()
  await run
} finally {
  relay.stop()
  detachConnection(db, stable, 'bridge', 'test-bridge')
  db.close()
  rmSync(temp, { recursive: true, force: true })
}
