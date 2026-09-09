// Opt-in real App Server/model check. Temporary database; no live peer messages.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { AppServerClient } from './app-server-client.mjs'
import { CodexRelay } from './relay.mjs'
import { openDb, sendMessage, listSeats } from '../bridge/chat-db.mjs'

if (process.env.INTERCOM_LIVE_CODEX_TEST !== '1') {
  console.log('SKIP: set INTERCOM_LIVE_CODEX_TEST=1 (uses your Codex account for one test turn)')
  process.exit(0)
}
const dir = mkdtempSync(join(tmpdir(), 'intercom-live-lifecycle-'))
const dbPath = join(dir, 'chat.db')
const file = join(dir, 'identity')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const db = openDb(dbPath)
const events = []
const children = []
let relay, client, relayRun, threadId
async function until(fn, label, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function startServer() {
  writeFileSync(file, 'codex-startup:pending')
  const port = await new Promise((r) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
  const endpoint = `ws://127.0.0.1:${port}`
  const args = ['app-server', '--listen', endpoint]
  const overrides = {
    'mcp_servers.intercom.command': 'node',
    'mcp_servers.intercom.args': [resolve(process.env.INTERCOM_BRIDGE_PATH || 'bridge/bridge.mjs')],
    'mcp_servers.intercom.env.CHAT_DB': dbPath,
    'mcp_servers.intercom.env.CHAT_IDENTITY_FILE': file,
    'mcp_servers.intercom.env.CHAT': 'initial-room',
    'mcp_servers.intercom.env.SEAT': 'initial-seat',
  }
  for (const [key, value] of Object.entries(overrides))
    args.push('-c', `${key}=${JSON.stringify(value)}`)
  const child = spawn('codex', args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', (b) => {
    errors += b
  })
  children.push(child)
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`App Server exited: ${errors}`)
      try {
        return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok
      } catch {
        return false
      }
    },
    'server readiness',
    15000
  )
  client = new AppServerClient(endpoint)
  client.on('notification', (method, params) => events.push({ method, ...params }))
  await client.connect()
  const response = await client.request(threadId ? 'thread/resume' : 'thread/start', {
    ...(threadId ? { threadId } : {}),
    cwd: dir,
    sandbox: 'read-only',
    approvalPolicy: 'never',
  })
  assert(!threadId || response.thread.id === threadId)
  threadId = response.thread.id
  relay = new CodexRelay({
    endpoint,
    dbPath,
    chat: 'initial-room',
    identityFile: file,
    threadId,
    pollMs: 100,
    skillPath: join(dir, 'no-skill'),
    log: (msg) => console.log('[relay]', msg),
  })
  relayRun = relay.start()
  relayRun.catch((e) => {
    errors += e.stack
  })
  await until(
    () => listSeats(db, 'initial-room').some((s) => s.identity === `codex:${threadId}`),
    'bridge identity',
    15000
  )
  return child
}
async function stopServer(child) {
  relay.stop()
  await relayRun
  client.close()
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await sleep(600)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
const tool = (name, args) =>
  client.request('mcpServer/tool/call', {
    threadId,
    server: 'intercom',
    tool: name,
    arguments: args,
  })
try {
  let child = await startServer()
  await tool('join', { chat: 'initial-room', seat: 'Exact-Name' })
  await tool('join', { chat: 'second-room', seat: 'Other-Exact-Name' })
  const working = await client.request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'This is an Intercom integration test. Use your terminal tool to run sleep 12. When it finishes, acknowledge any incoming Intercom message token and then say ORIGINAL_WORK_DONE. Do not read or modify any files, invoke other tools, or send messages.',
      },
    ],
  })
  await until(
    () => events.some((e) => e.method === 'item/started' && e.item?.type === 'commandExecution'),
    'running shell command'
  )
  const originalTurn = working.turn.id
  const active = await client.request('thread/read', { threadId, includeTurns: false })
  assert.equal(active.thread.status.type, 'active')
  const id = sendMessage(
    db,
    'second-room',
    'synthetic-peer',
    'Please surface BUSY_INTERCOM_RECEIVED and continue the original task.',
    {
      senderIdentity: 'claude:synthetic-peer',
      toSeat: 'Other-Exact-Name',
      toIdentity: `codex:${threadId}`,
    }
  )
  await until(
    () =>
      db.prepare('SELECT state FROM delivery_receipts WHERE message_id=?').get(id)?.state ===
      'accepted',
    'steer acceptance'
  )
  const receipt = db.prepare('SELECT * FROM delivery_receipts WHERE message_id=?').get(id)
  assert.equal(receipt.turn_id, originalTurn)
  assert.match(receipt.detail, /turn\/steer/)
  console.log(
    'PASS: peer message accepted by turn/steer during a real terminal command, in the original turn'
  )
  await until(
    () => events.some((e) => e.method === 'turn/completed' && e.turn.id === originalTurn),
    'completed original turn'
  )
  const replies = events
    .filter((e) => e.method === 'item/completed' && e.item?.type === 'agentMessage')
    .map((e) => e.item.text)
    .join('\n')
  assert.match(replies, /BUSY_INTERCOM_RECEIVED/)
  assert.match(replies, /ORIGINAL_WORK_DONE/)
  console.log('PASS: real Codex acknowledged the incoming token and completed its original task')
  await stopServer(child)
  child = await startServer()
  const rooms = await tool('chats', {})
  const text = rooms.content.map((c) => c.text || '').join('\n')
  assert.match(text, /initial-room \(seat Exact-Name\)/)
  assert.match(text, /second-room \(seat Other-Exact-Name\)/)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM delivery_receipts WHERE message_id=?').get(id).n,
    1
  )
  console.log(
    'PASS: actual App Server restart/resume retained thread ID, both exact seats and accepted delivery'
  )
  // Fork gets its own ID. Do not attach a second relay to the same server.
  const fork = await client.request('thread/fork', { threadId, cwd: dir })
  assert.notEqual(fork.thread.id, threadId)
  console.log('PASS: actual Codex fork has a different thread ID')
  await stopServer(child)
} finally {
  relay?.stop()
  client?.close()
  for (const child of children)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
