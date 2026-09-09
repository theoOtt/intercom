import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { codexThreadId } from './codex-metadata.mjs'
import { openDb } from './chat-db.mjs'

const aId = randomUUID(), bId = randomUUID()
const meta = (id) => ({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: id }) })
assert.equal(codexThreadId(meta(aId)), aId)
assert.equal(codexThreadId({ 'openai/threadId': aId }), aId)
assert.equal(codexThreadId({ thread: { id: aId } }), aId)
assert.equal(codexThreadId({}), null)
assert.throws(() => codexThreadId({ ...meta(aId), thread_id: bId }), /Conflicting/)
assert.throws(() => codexThreadId({ thread_id: 'seat-a' }), /invalid/)
assert.throws(() => codexThreadId({ 'x-codex-turn-metadata': '{' }), /Invalid/)

const dir = mkdtempSync(join(tmpdir(), 'intercom-metadata-'))
const dbPath = join(dir, 'chat.db')
const clients = []
const text = (r) => r.content.map((item) => item.text || '').join('\n')
async function start(id, extraEnv = {}) {
  const client = new Client({ name: 'codex-mcp-client', version: '1.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.INTERCOM_BRIDGE_PATH || fileURLToPath(new URL('./bridge.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CHAT_DB: dbPath,
      CHAT: 'same-project', CHAT_DESKTOP_RELAY: '0', CODEX_THREAD_ID: 'inherited-wrong-parent',
      CLAUDE_CODE_SESSION_ID: 'inherited-claude-parent', ...extraEnv }, stderr: 'pipe',
  })
  transport.stderr.on('data', () => {})
  await client.connect(transport)
  clients.push(client)
  return { client, call: (name, args = {}, m = meta(id)) => client.callTool({ name, arguments: args, _meta: m }) }
}

try {
  const launcherId = randomUUID()
  const launcher = await start(aId, { CHAT_IDENTITY: `codex:${launcherId}` })
  await assert.rejects(launcher.call('chats'), /does not match/)
  assert.match(text(await launcher.call('chats', {}, meta(launcherId))), new RegExp(launcherId))
  await launcher.client.close()
  let a = await start(aId)
  assert.deepEqual((await a.client.listTools()).tools.map((t) => t.name).sort(),
    ['chats','history','join','leave','rename','send','who'])
  await assert.rejects(a.call('chats', {}, {}), /Waiting for the actual/)
  const db = openDb(dbPath)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seats').get().n, 0)
  db.close()
  assert.match(text(await a.call('chats')), new RegExp(`Identity: codex:${aId}`))
  assert.match(text(await a.call('chats')), /MCP pull-only/)
  await a.call('join', { chat: 'review', seat: 'Desktop-Reviewer' })
  await a.call('join', { chat: 'second', seat: 'Second-Name' })
  await a.call('rename', { chat: 'second', to: 'renamed' })
  await assert.rejects(a.call('send', { chat: 'review', body: 'wrong identity' }, meta(bId)), /different task/)
  await assert.rejects(a.call('chats', {}, {}), /Missing/)
  const duplicate = await start(aId)
  await assert.rejects(duplicate.call('chats'), /already has a live/)
  await duplicate.client.close()
  const b = await start(bId)
  assert.doesNotMatch(text(await b.call('chats')), /Desktop-Reviewer/)
  await b.call('join', { chat: 'review', seat: 'Peer' })
  await b.call('send', { chat: 'review', to: 'Desktop-Reviewer', body: 'direct-private' })
  assert.match(text(await a.call('history', { chat: 'review' })), /direct-private/)
  assert.match(text(await a.call('who', { chat: 'review' })), /Peer/)
  await a.client.close()
  a = await start(aId)
  assert.match(text(await a.call('chats')), /review \(seat Desktop-Reviewer\)/)
  assert.match(text(await a.call('chats')), /renamed \(seat Second-Name\)/)
  assert.match(text(await a.call('history', { chat: 'review' })), /direct-private/)
  await a.call('leave', { chat: 'review' })
  await a.client.close()
  a = await start(aId)
  assert.doesNotMatch(text(await a.call('chats')), /review \(seat/)
  console.log('PASS: seven metadata-bound MCP tools, exact-name restore, directed history, separate same-project sessions, missing/conflicting metadata, duplicates, and explicit leave')
} finally {
  for (const client of clients) await client.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}
