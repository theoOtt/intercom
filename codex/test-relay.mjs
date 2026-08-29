// Isolated relay test: fake App Server, real SQLite schema and identity migration.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexRelay } from './relay.mjs'
import { openDb, claimSeat, sendMessage, history } from '../bridge/chat-db.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  process.stdout.write(`PASS: ${message}\n`)
}
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
  for (let attempt = 0; attempt < 100 && !logs.some((line) => line.startsWith('attached')); attempt++) {
    await sleep(10)
  }
  const stable = `codex:${threadId}`
  assert(readFileSync(identityFile, 'utf8').trim() === stable, 'relay adopts Codex thread UUID as durable identity')

  sendMessage(db, 'relay-test', 'claude', 'wake the reviewer', {
    senderIdentity: 'claude:sender',
    toSeat: 'reviewer',
    toIdentity: stable,
  })
  for (let attempt = 0; attempt < 100 && fake.turns.length === 0; attempt++) await sleep(10)
  assert(fake.turns.length === 1, 'direct message starts exactly one Codex turn')
  assert(fake.turns[0].input[0].text.includes('wake the reviewer'), 'turn contains peer message body')
  assert(fake.turns[0].input[0].text.includes('From seat: claude'), 'turn identifies the sender seat')

  sendMessage(db, 'relay-test', 'claude', 'room broadcast', { senderIdentity: 'claude:sender' })
  for (let attempt = 0; attempt < 100 && fake.turns.length < 2; attempt++) await sleep(10)
  assert(fake.turns.length === 2, 'broadcast also starts a Codex turn')

  const privateForSomeoneElse = sendMessage(db, 'relay-test', 'claude', 'not for reviewer', {
    senderIdentity: 'claude:sender',
    toSeat: 'someone-else',
    toIdentity: 'codex:someone-else',
  })
  await sleep(80)
  assert(fake.turns.length === 2, 'direct message to another identity is ignored')
  assert(
    !history(db, 'relay-test', { viewerIdentity: stable }).some((row) => row.id === privateForSomeoneElse),
    'other direct message is hidden from resumed session history'
  )
  relay.stop()
  await run
} finally {
  relay.stop()
  rmSync(temp, { recursive: true, force: true })
}
