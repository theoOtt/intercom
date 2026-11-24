// Uses the installed Copilot SDK without extensions, inference, or shared rooms.
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

if (!process.env.INTERCOM_TEST_SDK || !process.env.INTERCOM_TEST_BUILD)
  throw new Error('Set INTERCOM_TEST_SDK and INTERCOM_TEST_BUILD to the host SDK and bridge build')
const { CopilotClient } = require(process.env.INTERCOM_TEST_SDK)
const temp = mkdtempSync(join(tmpdir(), 'intercom-native-mcp-'))
const client = new CopilotClient({
  baseDirectory: temp, workingDirectory: temp, useLoggedInUser: false,
  env: { ...process.env, COPILOT_AGENT_SESSION_ID: randomUUID() },
})
const options = {
  workingDirectory: temp, configDirectory: temp,
  requestExtensions: false, enableConfigDiscovery: false, enableSkills: false,
  skipCustomInstructions: true, availableTools: ['mcp:*'],
  infiniteSessions: { enabled: false }, memory: { enabled: false },
  mcpServers: {
    intercom: {
      command: process.env.INTERCOM_NODE || 'node',
      args: ['--no-warnings', join(resolve(process.env.INTERCOM_TEST_BUILD), 'bridge.mjs')],
      env: { CHAT_DB: join(temp, 'chat.db'), CHAT_AUTOJOIN_PROJECT: '0' },
      tools: ['*'],
    },
  },
  onPermissionRequest: () => ({ kind: 'approve-once' }),
}
async function ready(session) {
  await session.rpc.mcp.list()
  await session.rpc.tools.initializeAndValidate()
}
async function tool(session, name, args = {}) {
  const result = await session.rpc.tools.execute({ name: `intercom-${name}`, arguments: args })
  assert.equal(result.resultType, 'success', result.textResultForLlm)
  return result.textResultForLlm
}
;(async () => {
  try {
    const id = randomUUID()
    let a = await client.createSession({ ...options, sessionId: id })
    const b = await client.createSession({ ...options, sessionId: randomUUID() })
    await ready(a)
    await ready(b)
    const state = await tool(a, 'chats')
    assert(state.includes(`Identity: copilot:${id}`))
    assert(state.includes('MCP pull-only'))
    assert(!(await tool(b, 'chats')).includes(`Identity: copilot:${id}`))
    console.log('PASS: actual runtime supplies independent MCP conversation UUIDs instead of inherited IDs')
    await tool(a, 'join', { chat: 'native-mcp-test', seat: 'MCP-A' })
    await tool(b, 'join', { chat: 'native-mcp-test', seat: 'MCP-B' })
    assert((await tool(a, 'who', { chat: 'native-mcp-test' })).includes('MCP-B'))
    await tool(b, 'send', { chat: 'native-mcp-test', to: 'MCP-A', body: 'native MCP message' })
    assert((await tool(a, 'history', { chat: 'native-mcp-test' })).includes('native MCP message'))
    assert(!(await a.getEvents()).some((event) => event.type === 'user.message'))
    console.log('PASS: actual standard MCP tools provide presence and directed history without wake-up or inference')
    await a.rpc.mcp.stopServer({ serverName: 'intercom' })
    await a.disconnect()
    const inspection = new DatabaseSync(join(temp, 'chat.db'), { readOnly: true })
    try {
      for (let attempt = 0; attempt < 140; attempt++) {
        const lease = inspection.prepare(
          "SELECT expires_at FROM connection_leases WHERE identity=? AND role='bridge'"
        ).get(`copilot:${id}`)
        if (!lease || lease.expires_at <= Date.now()) break
        if (attempt === 139) throw new Error('Stopped MCP server retained a live ownership lease beyond its expiry window')
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    } finally {
      inspection.close()
    }
    a = await client.resumeSession(id, options)
    await ready(a)
    assert((await tool(a, 'chats')).includes('native-mcp-test (seat MCP-A)'))
    console.log('PASS: explicit MCP stop/reconnect restores the exact UUID-backed room and seat')
  } finally {
    const errors = await client.stop()
    rmSync(temp, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Standard MCP test cleanup failed')
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
