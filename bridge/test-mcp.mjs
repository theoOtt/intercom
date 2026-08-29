// End-to-end stdio MCP test using three bridge processes and a disposable DB.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, listSeats, getDeliveryCursor } from './chat-db.mjs'

const temp = mkdtempSync(join(tmpdir(), 'intercom-mcp-'))
const dbPath = join(temp, 'chat.db')
const bridgePath = resolve('bridge/bridge.mjs')

async function session(name, identity) {
  const client = new Client({ name: `test-${name}`, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: 'node',
    args: [bridgePath],
    env: { ...process.env, CHAT_DB: dbPath, CHAT_IDENTITY: identity },
    stderr: 'pipe',
  })
  await client.connect(transport)
  return { client, transport }
}
const text = (result) => result.content?.find((item) => item.type === 'text')?.text || ''
const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  process.stdout.write(`PASS: ${message}\n`)
}

const sessions = []
try {
  const a = await session('a', 'claude:session-a')
  const b = await session('b', 'codex:session-b')
  const c = await session('c', 'codex:session-c')
  sessions.push(a, b, c)

  const tools = (await a.client.listTools()).tools.map((tool) => tool.name).sort()
  assert(
    JSON.stringify(tools) === JSON.stringify(['chats', 'history', 'join', 'leave', 'rename', 'send', 'who']),
    'bridge exposes all seven standard MCP tools'
  )

  await a.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'claude' } })
  await b.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'codex-b' } })
  await c.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'codex-c' } })

  const sent = text(await a.client.callTool({
    name: 'send',
    arguments: { chat: 'direct-test', to: 'codex-b', body: 'private review request' },
  }))
  assert(sent.includes('Sent directly to "codex-b"'), 'send accepts an exact direct recipient')

  const bHistory = text(await b.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
  const cHistory = text(await c.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
  assert(bHistory.includes('claude -> codex-b: private review request'), 'recipient history contains direct message')
  assert(!cHistory.includes('private review request'), 'other seat history hides direct message')

  await a.client.callTool({
    name: 'send',
    arguments: { chat: 'direct-test', body: 'room update' },
  })
  const cAfterBroadcast = text(await c.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
  assert(cAfterBroadcast.includes('room update'), 'broadcast remains visible to every seat')

  const unknown = await a.client.callTool({
    name: 'send',
    arguments: { chat: 'direct-test', to: 'missing', body: 'should fail' },
  }).then(() => null, (error) => error)
  assert(unknown instanceof Error, 'unknown direct seat is rejected')

  await b.client.callTool({
    name: 'join', arguments: { chat: 'direct-test', seat: 'codex-b-renamed' },
  })
  let inspect = openDb(dbPath)
  let bSeats = listSeats(inspect, 'direct-test')
    .filter((seat) => seat.identity === 'codex:session-b')
  assert(
    bSeats.length === 1 && bSeats[0].seat === 'codex-b-renamed',
    'changing seat in one room releases the previous seat instead of leaking membership'
  )
  assert(
    getDeliveryCursor(inspect, 'direct-test', 'codex:session-b', 'codex-app-server') !== null,
    'Codex room join seeds an independent wake cursor'
  )
  inspect.close()

  await b.client.callTool({ name: 'join', arguments: { chat: 'second-room', seat: 'codex-b' } })
  inspect = openDb(dbPath)
  assert(
    getDeliveryCursor(inspect, 'second-room', 'codex:session-b', 'codex-app-server') !== null,
    'runtime second-room join seeds its own wake cursor'
  )
  inspect.close()

  await b.client.callTool({ name: 'leave', arguments: { chat: 'second-room' } })
  inspect = openDb(dbPath)
  assert(
    getDeliveryCursor(inspect, 'second-room', 'codex:session-b', 'codex-app-server') === null,
    'explicit room leave removes only that room wake cursor'
  )
  inspect.close()
} finally {
  for (const session of sessions.reverse()) {
    try { await session.client.close() } catch {}
  }
  rmSync(temp, { recursive: true, force: true })
}
