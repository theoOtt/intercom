// Isolated relay test: fake App Server, real SQLite schema and identity migration.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexRelay } from './relay.mjs'
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
  }
  setServerRequestHandler(handler) { this.handler = handler }
  async connect() {}
  close() {}
  async request(method, params) {
    if (method === 'thread/loaded/list') return { data: [this.threadId], nextCursor: null }
    if (method === 'thread/read') return { thread: { id: this.threadId, status: { type: 'idle' } } }
    if (method === 'turn/start') {
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
writeFileSync(identityFile, `${provisional}\n`)
const db = openDb(dbPath)
claimSeat(db, 'relay-test', 'reviewer', provisional)
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
  const stable = `codex:${threadId}`
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
  claimSeat(db, 'second-room', 'reviewer-two', stable)
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

  deleteDeliveryCursor(db, 'renamed-room', stable, 'codex-app-server')
  releaseSeat(db, 'renamed-room', 'reviewer-two')
  sendMessage(db, 'renamed-room', 'claude-two', 'message while explicitly absent', {
    senderIdentity: 'claude:sender-two',
  })
  await sleep(80)
  assert(fake.turns.length === 6, 'explicitly left room is no longer watched')

  claimSeat(db, 'renamed-room', 'reviewer-returned', stable)
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
  relay.stop()
  await run
} finally {
  relay.stop()
  rmSync(temp, { recursive: true, force: true })
}
