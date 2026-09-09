// Exercise real MCP subprocess restarts, not just database helpers.
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openDb, sendMessage } from './chat-db.mjs'

const dir = mkdtempSync(join(tmpdir(), 'intercom-lifecycle-'))
const dbPath = join(dir, 'chat.db')
const identityFile = join(dir, 'identity')
const id = `codex:${randomUUID()}`
const clients = []
async function session(identity, file = null, options = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CHAT_DB: dbPath,
    CHAT: 'same-project',
    SEAT: 'Default',
    CHAT_IDENTITY: identity,
  }
  if (file) env.CHAT_IDENTITY_FILE = file
  Object.assign(env, options.env || {})
  const client = new Client({ name: options.clientName || 'lifecycle', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      process.env.INTERCOM_BRIDGE_PATH || fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
    ],
    env,
    stderr: 'pipe',
  })
  let errorOutput = ''
  transport.stderr.on('data', (b) => {
    errorOutput += b
  })
  await client.connect(transport)
  clients.push(client)
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    errors: () => errorOutput,
  }
}
const text = (r) => r.content.map((x) => x.text || '').join('\n')
try {
  writeFileSync(identityFile, `codex-startup:${randomUUID()}`)
  let a = await session('ignored', identityFile)
  await assert.rejects(a.call('chats'), /Waiting for the actual/)
  let db = openDb(dbPath)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seats').get().n, 0)
  db.close()
  writeFileSync(identityFile, id)
  await a.call('join', { chat: 'same-project', seat: 'HomeAssistant' })
  await a.call('join', { chat: 'second', seat: 'Code-Reviewer' })
  await a.call('rename', { chat: 'second', to: 'renamed' })
  await a.call('join', { chat: 'left', seat: 'Transient' })
  await a.call('leave', { chat: 'left' })
  const duplicate = await session(id)
  await assert.rejects(
    duplicate.call('send', { chat: 'same-project', body: 'impersonation' }),
    /already has a live/
  )
  await duplicate.client.close()
  await a.client.close()
  db = openDb(dbPath)
  sendMessage(db, 'renamed', 'Peer', 'unread across close', {
    senderIdentity: 'claude:peer',
    toIdentity: id,
    toSeat: 'Code-Reviewer',
  })
  db.close()
  a = await session(id)
  const rooms = text(await a.call('chats'))
  assert.match(rooms, /same-project \(seat HomeAssistant\)/)
  assert.match(rooms, /renamed \(seat Code-Reviewer\)/)
  assert.doesNotMatch(rooms, /left \(seat/)
  assert.match(text(await a.call('history', { chat: 'renamed' })), /unread across close/)
  const fork = await session(`codex:${randomUUID()}`)
  assert.doesNotMatch(text(await fork.call('chats')), /renamed \(seat/)
  await fork.call('join', { chat: 'renamed', seat: 'Code-Reviewer' })
  assert.doesNotMatch(text(await fork.call('history', { chat: 'renamed' })), /unread across close/)
  // A stale bridge stays alive but loses its lease, simulating a paused process
  // returning after another process reclaimed its expired connection.
  db = openDb(dbPath)
  db.prepare("UPDATE connection_leases SET expires_at=0 WHERE identity=? AND role='bridge'").run(id)
  db.close()
  const stale = a
  a = await session(id)
  await a.call('chats')
  await assert.rejects(
    stale.call('send', { chat: 'same-project', body: 'stale impersonation' }),
    /Lost/
  )
  await stale.client.close()
  assert.match(text(await a.call('chats')), /HomeAssistant/)
  await a.call('leave', { chat: 'renamed' })
  await a.call('leave', { chat: 'same-project' })
  await a.client.close()
  a = await session(id)
  assert.match(text(await a.call('chats')), /You are in: \(none\)/)
  const reviewer = await session('ignored-parent', identityFile, {
    clientName: 'claude-code',
    env: { CLAUDE_CODE_SESSION_ID: 'nested-reviewer' },
  })
  assert.match(text(await reviewer.call('chats')), /Identity: claude:nested-reviewer/)
  const nestedFile = join(dir, 'nested-codex-identity')
  writeFileSync(nestedFile, 'codex:nested-codex-thread')
  const nestedCodex = await session('ignored-parent', nestedFile, {
    clientName: 'codex-mcp-client',
    env: { CLAUDE_CODE_SESSION_ID: 'nested-reviewer' },
  })
  assert.match(text(await nestedCodex.call('chats')), /Identity: codex:nested-codex-thread/)
  console.log('PASS: nested Claude/Codex MCP hosts ignore inherited parent identity variables')
  console.log(
    'PASS: actual bridge waits for thread ID, rejects duplicates/stale owners, restores exact seats and renamed rooms, preserves direct history, isolates forks, and respects explicit leave'
  )
} finally {
  for (const client of clients)
    try {
      await client.close()
    } catch {}
  rmSync(dir, { recursive: true, force: true })
}
