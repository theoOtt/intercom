// Verify that a Codex App Server passes launcher session identity/chat variables
// through to the configured stdio Intercom MCP bridge without starting a model turn.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppServerClient } from './app-server-client.mjs'
import {
  history,
  openDb,
  listIdentityMemberships,
  getDeliveryCursor,
} from '../bridge/chat-db.mjs'

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
// Keep the database inside the thread's writable workspace. Codex sandboxing can
// give MCP subprocesses a private view of OS temporary directories.
const temp = mkdtempSync(join(process.cwd(), '.intercom-codex-env-'))
const codexHome = join(temp, '.codex')
const dbPath = join(temp, 'chat.db')
const identityFile = join(temp, 'identity')
const bridgePath = resolve('bridge/bridge.mjs')
const provisional = `codex-startup:${randomUUID()}`
mkdirSync(codexHome, { recursive: true })
writeFileSync(identityFile, `${provisional}\n`)
writeFileSync(join(codexHome, 'config.toml'), `
[mcp_servers.intercom]
command = "node"
args = ["${bridgePath}"]

[mcp_servers.intercom.env]
CHAT_DB = "${dbPath}"
CHAT_AUTOJOIN_PROJECT = "1"
`)

const port = await new Promise((resolvePromise, reject) => {
  const socket = createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address()
    socket.close(() => resolvePromise(address.port))
  })
})
const endpoint = `ws://127.0.0.1:${port}`
const dynamicMcpEnv = {
  CHAT_DB: dbPath,
  CHAT_AUTOJOIN_PROJECT: '1',
  CHAT: 'environment-test',
  SEAT: 'reviewer',
  CHAT_IDENTITY_FILE: identityFile,
}
const serverArgs = ['app-server', '--listen', endpoint]
for (const [name, value] of Object.entries(dynamicMcpEnv)) {
  serverArgs.push('-c', `mcp_servers.intercom.env.${name}=${JSON.stringify(value)}`)
}
const server = spawn('codex', serverArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CHAT: 'environment-test',
    SEAT: 'reviewer',
    CHAT_IDENTITY_FILE: identityFile,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
let stderr = ''
const startupEvents = []
server.stderr.on('data', (chunk) => { stderr += chunk })

try {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`)
      if (ready.ok) break
    } catch {}
    await sleep(100)
  }
  const client = new AppServerClient(endpoint, { clientName: 'intercom_environment_test' })
  await client.connect()
  client.on('mcpServer/startupStatus/updated', (event) => startupEvents.push(event))
  const result = await client.request('thread/start', { cwd: process.cwd() })
  if (!result.thread?.id) throw new Error('thread/start did not return a thread id')
  // A brand-new isolated CODEX_HOME initializes its bundled plugins just after
  // thread creation. Let that one-time config refresh settle before MCP startup.
  await sleep(750)

  const expectedTools = ['chats', 'history', 'join', 'leave', 'rename', 'send', 'who']
  // The first inventory request triggers startup. Wait for the asynchronous
  // ready notification before asking for the complete tool inventory.
  await client.request('mcpServerStatus/list', {
    threadId: result.thread.id,
    detail: 'full',
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const event = startupEvents.find(
      (candidate) => candidate.threadId === result.thread.id && candidate.name === 'intercom' &&
        (candidate.status === 'ready' || candidate.status === 'failed')
    )
    if (event?.status === 'failed') throw new Error(`Intercom startup failed: ${event.error}`)
    if (event?.status === 'ready') break
    await sleep(50)
  }
  const status = await client.request('mcpServerStatus/list', {
    threadId: result.thread.id,
    detail: 'full',
  })
  const intercom = status.data?.find((candidate) => candidate.name === 'intercom')
  const actualTools = Object.keys(intercom?.tools || {}).sort()
  if (!intercom) throw new Error(`Intercom was absent from MCP status: ${JSON.stringify(status)}`)
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected Intercom tools: ${JSON.stringify(actualTools)}; status=${JSON.stringify(status)}`)
  }
  const chatResult = await client.request('mcpServer/tool/call', {
    server: 'intercom',
    threadId: result.thread.id,
    tool: 'chats',
    arguments: {},
  })
  const chatText = chatResult.content?.find((item) => item.type === 'text')?.text || ''
  if (!chatText.includes('environment-test (seat reviewer)')) {
    throw new Error(`Dynamic chat/seat configuration was not inherited: ${JSON.stringify(chatResult)}`)
  }
  await client.request('mcpServer/tool/call', {
    server: 'intercom',
    threadId: result.thread.id,
    tool: 'join',
    arguments: { chat: 'environment-second', seat: 'reviewer-two' },
  })
  let secondMembership = null
  let secondCursor = null
  for (let attempt = 0; attempt < 100 && (!secondMembership || secondCursor === null); attempt++) {
    const db = openDb(dbPath)
    secondMembership = listIdentityMemberships(db, provisional)
      .find((candidate) => candidate.chat === 'environment-second')
    secondCursor = getDeliveryCursor(
      db, 'environment-second', provisional, 'codex-app-server'
    )
    db.close()
    if (!secondMembership || secondCursor === null) await sleep(50)
  }
  if (secondMembership?.seat !== 'reviewer-two' || secondCursor === null) {
    throw new Error(
      `Runtime room join did not persist membership/cursor: ` +
      `${JSON.stringify({ secondMembership, secondCursor })}`
    )
  }
  await client.request('mcpServer/tool/call', {
    server: 'intercom',
    threadId: result.thread.id,
    tool: 'leave',
    arguments: { chat: 'environment-second' },
  })
  const afterLeave = openDb(dbPath)
  const leftMembership = listIdentityMemberships(afterLeave, provisional)
    .find((candidate) => candidate.chat === 'environment-second')
  const leftCursor = getDeliveryCursor(
    afterLeave, 'environment-second', provisional, 'codex-app-server'
  )
  afterLeave.close()
  if (leftMembership || leftCursor !== null) {
    throw new Error(
      `Runtime room leave retained membership/cursor: ` +
      `${JSON.stringify({ leftMembership, leftCursor })}`
    )
  }
  await client.request('mcpServer/tool/call', {
    server: 'intercom',
    threadId: result.thread.id,
    tool: 'send',
    arguments: { chat: 'environment-test', body: 'environment identity probe' },
  })

  let message = null
  for (let attempt = 0; attempt < 100 && !message; attempt++) {
    const db = openDb(dbPath)
    message = history(db, 'environment-test', { limit: 10 })
      .find((candidate) => candidate.body === 'environment identity probe')
    db.close()
    if (!message) await sleep(50)
  }
  if (message?.sender_identity !== provisional) {
    throw new Error(
      `MCP database/identity configuration was not inherited; observed=${JSON.stringify(message)}`
    )
  }
  process.stdout.write(
    'PASS: Codex started Intercom, exposed all seven tools, inherited its environment, and persisted runtime room join/leave boundaries\n'
  )
  client.close()
} catch (error) {
  throw new Error(
    `${error.message}\nMCP startup events: ${JSON.stringify(startupEvents)}\nApp Server stderr:\n${stderr}`
  )
} finally {
  try { process.kill(-server.pid, 'SIGTERM') } catch {}
  // App Server and its MCP child can take a moment to leave the process group.
  // Wait for the parent before removing files it may still be writing.
  if (server.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => server.once('exit', resolvePromise)),
      sleep(2_000),
    ])
  }
  if (server.exitCode === null) {
    try { process.kill(-server.pid, 'SIGKILL') } catch {}
    await Promise.race([
      new Promise((resolvePromise) => server.once('exit', resolvePromise)),
      sleep(2_000),
    ])
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      break
    } catch (error) {
      if (attempt === 19) throw error
      await sleep(50)
    }
  }
}
