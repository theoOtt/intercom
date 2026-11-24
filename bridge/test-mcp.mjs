// End-to-end stdio MCP test using three bridge processes and a disposable DB.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openDb, listSeats, getDeliveryCursor } from './chat-db.mjs'

const temp = mkdtempSync(join(tmpdir(), 'intercom-mcp-'))
const useDefaultDb = process.env.INTERCOM_TEST_DEFAULT_DB === '1'
const dbPath = useDefaultDb
  ? join(temp, '.claude', 'intercom', 'chat.db')
  : join(temp, 'chat.db')
const bridgePath = process.env.INTERCOM_BRIDGE_PATH
  ? resolve(process.env.INTERCOM_BRIDGE_PATH)
  : join(dirname(fileURLToPath(import.meta.url)), 'bridge.mjs')

async function session(name, identity, overrides = {}) {
  const host = name === 'copilot' ? 'copilot-intercom' : name === 'copilot-mcp' ? 'copilot-cli' : `test-${name}`
  const client = new Client({ name: host, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: 'node',
    args: [bridgePath],
    env: {
      ...process.env,
      HOME: useDefaultDb ? temp : process.env.HOME,
      ...(useDefaultDb ? {} : { CHAT_DB: dbPath }),
      CHAT_IDENTITY: identity,
      ...overrides,
    },
    stderr: process.env.INTERCOM_TEST_STDERR === '1' ? 'inherit' : 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk })
  try {
    await client.connect(transport)
  } catch (error) {
    throw new Error(`session ${name} failed to connect: ${error.message}\n${stderr}`)
  }
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

  const copilotId = randomUUID()
  const copilotEnv = { INTERCOM_COPILOT_SESSION_ID: copilotId }
  const copilot = await session('copilot', 'claude:inherited-parent', copilotEnv)
  sessions.push(copilot)
  const copilotState = text(await copilot.client.callTool({ name: 'chats', arguments: {} }))
  assert(copilotState.includes(`Identity: copilot:${copilotId}`),
    'Copilot uses its SDK UUID rather than an inherited Claude/Codex identity')
  await copilot.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'Copilot' } })
  await b.client.callTool({
    name: 'send', arguments: { chat: 'direct-test', to: 'Copilot', body: 'private Copilot message' },
  })
  assert(text(await copilot.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
    .includes('private Copilot message'), 'Copilot receives messages addressed to its own conversation')
  assert(!text(await c.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
    .includes('private Copilot message'), 'Copilot direct messages remain hidden from other sessions')
  inspect = openDb(dbPath)
  assert(getDeliveryCursor(inspect, 'direct-test', `copilot:${copilotId}`, 'copilot-sdk') !== null &&
    getDeliveryCursor(inspect, 'direct-test', `copilot:${copilotId}`, 'claude-channel') === null,
    'Copilot has an independent native-delivery cursor')
  inspect.close()
  const duplicate = await session('copilot', '', copilotEnv)
  sessions.push(duplicate)
  await duplicate.client.callTool({ name: 'chats', arguments: {} }).then(
    () => { throw new Error('Duplicate Copilot identity was accepted') },
    (error) => assert(error.message.includes('already has a live'), 'duplicate live Copilot attachments are rejected'),
  )
  await copilot.client.close()
  const resumed = await session('copilot', '', copilotEnv)
  sessions.push(resumed)
  assert(text(await resumed.client.callTool({ name: 'chats', arguments: {} }))
    .includes('direct-test (seat Copilot)'), 'Copilot resume restores its exact saved room and seat')
  const fork = await session('copilot', '', { INTERCOM_COPILOT_SESSION_ID: randomUUID() })
  sessions.push(fork)
  await fork.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'Copilot' } })
  assert(!text(await fork.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
    .includes('private Copilot message'), 'a new Copilot conversation cannot inherit private history by seat name')
  const missing = await session('copilot', 'claude:inherited-parent', { INTERCOM_COPILOT_SESSION_ID: '' })
  sessions.push(missing)
  await missing.client.callTool({ name: 'chats', arguments: {} }).then(
    () => { throw new Error('Missing Copilot UUID was accepted') },
    (error) => assert(error.message.includes('No resumable session ID'), 'Copilot refuses missing SDK identity without a parent fallback'),
  )

  const mcpId = randomUUID()
  const mcpEnv = {
    COPILOT_AGENT_SESSION_ID: mcpId,
    INTERCOM_COPILOT_SESSION_ID: randomUUID(),
    CLAUDE_CODE_SESSION_ID: randomUUID(),
    CHAT_AUTOJOIN_PROJECT: '0',
  }
  const mcp = await session('copilot-mcp', 'codex:inherited-parent', mcpEnv)
  sessions.push(mcp)
  const mcpState = text(await mcp.client.callTool({ name: 'chats', arguments: {} }))
  assert(mcpState.includes(`Identity: copilot:${mcpId}`) &&
    mcpState.includes('MCP pull-only') && mcpState.includes('No automatic wake-up'),
    'standard Copilot MCP uses the runtime conversation UUID and explicitly reports pull-only delivery')
  await mcp.client.callTool({ name: 'join', arguments: { chat: 'direct-test', seat: 'MCP-Copilot' } })
  await a.client.callTool({
    name: 'send', arguments: { chat: 'direct-test', to: 'MCP-Copilot', body: 'standard MCP direct message' },
  })
  assert(text(await mcp.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
    .includes('standard MCP direct message'),
    'standard Copilot MCP reads a directed message through ordinary history')
  assert(!text(await resumed.client.callTool({ name: 'history', arguments: { chat: 'direct-test' } }))
    .includes('standard MCP direct message'),
    'standard MCP private messages remain isolated from another Copilot conversation')
  await mcp.client.close()
  const mcpResume = await session('copilot-mcp', '', mcpEnv)
  sessions.push(mcpResume)
  assert(text(await mcpResume.client.callTool({ name: 'chats', arguments: {} }))
    .includes('direct-test (seat MCP-Copilot)'),
    'standard MCP resume preserves the runtime UUID-backed room and seat')
  const noMcpIdentity = await session('copilot-mcp', 'codex:inherited-parent', {
    ...mcpEnv, COPILOT_AGENT_SESSION_ID: '',
  })
  sessions.push(noMcpIdentity)
  await noMcpIdentity.client.callTool({ name: 'chats', arguments: {} }).then(
    () => { throw new Error('Missing standard MCP UUID was accepted') },
    (error) => assert(error.message.includes('No resumable session ID'),
      'standard Copilot MCP refuses inherited identities when its runtime UUID is missing'),
  )
} finally {
  for (const session of sessions.reverse()) {
    try { await session.client.close() } catch {}
  }
  rmSync(temp, { recursive: true, force: true })
}
