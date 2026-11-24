// Run with the host's bundled SDK; no real model calls or shared-room writes.
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')

if (!process.env.INTERCOM_TEST_SDK || !process.env.INTERCOM_TEST_BUILD || !process.env.INTERCOM_TEST_EXTENSION_SDK)
  throw new Error('Set INTERCOM_TEST_SDK, INTERCOM_TEST_EXTENSION_SDK, and INTERCOM_TEST_BUILD to the host SDK and adapter build')
const { CopilotClient } = require(process.env.INTERCOM_TEST_SDK)
const temp = mkdtempSync(join(tmpdir(), 'intercom-native-copilot-'))
const home = join(temp, 'copilot-home')
const entry = join(home, 'extensions', 'intercom', 'extension.mjs')
mkdirSync(join(home, 'extensions', 'intercom'), { recursive: true })
writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(join(resolve(process.env.INTERCOM_TEST_BUILD), 'extension.mjs')).href)}\n`)
const client = new CopilotClient({
  baseDirectory: home,
  workingDirectory: temp,
  useLoggedInUser: false,
  logLevel: 'debug',
  extensionLaunchProvider: {
    resolve: async ({ modulePath, source }) => modulePath === entry && source === 'user'
      ? {
          launch: {
            executable: process.execPath,
            args: [join(dirname(process.env.INTERCOM_TEST_EXTENSION_SDK), 'preloads', 'extension_bootstrap.mjs')],
            env: { EXTENSION_PATH: modulePath, ELECTRON_RUN_AS_NODE: '1' },
          },
        }
      : {},
  },
  env: {
    ...process.env,
    CHAT_DB: join(temp, 'chat.db'),
    CHAT_AUTOJOIN_PROJECT: '0',
    INTERCOM_NODE: process.env.INTERCOM_NODE || 'node',
  },
})
const options = {
  workingDirectory: temp,
  configDirectory: home,
  requestExtensions: true,
  extensionSdkPath: process.env.INTERCOM_TEST_EXTENSION_SDK,
  enableConfigDiscovery: true,
  skipCustomInstructions: true,
  enableSkills: false,
  availableTools: ['custom:*'],
  infiniteSessions: { enabled: false },
  memory: { enabled: false },
  onPermissionRequest: () => ({ kind: 'approved' }),
}
let fixtureRequests = 0
const fixture = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
    response.writeHead(404).end('Unexpected fixture request')
    return
  }
  request.resume()
  request.on('end', () => {
    fixtureRequests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: 'Intercom fixture acknowledgement' }, null],
      [{}, 'stop'],
    ]) {
      response.write(`data: ${JSON.stringify({
        id: 'intercom-fixture', object: 'chat.completion.chunk', created: 0,
        model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
})

async function ready(session) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const { extensions } = await session.rpc.extensions.list()
    const extension = extensions.find((item) => item.name === 'intercom')
    if (extension?.status === 'failed') {
      const events = await session.getEvents()
      const details = events.filter((event) => /extension|warning|error/.test(event.type))
      for (const file of readdirSync(home, { recursive: true }).filter((name) => name.endsWith('.log'))) {
        const lines = readFileSync(join(home, file), 'utf8').split('\n')
          .filter((line) => /extension.bootstrap|[Ee]xtension.*(fail|error)|Dynamic require|Failed to load extension/.test(line))
        for (const line of lines.slice(-15)) console.error(line.slice(0, 1500))
      }
      throw new Error(`Native SDK extension failed: ${JSON.stringify(extension)}\n${JSON.stringify(details)}`)
    }
    if (extension?.status === 'running') {
      await session.rpc.tools.initializeAndValidate()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Native SDK did not load the Intercom extension within 20 seconds')
}

async function tool(session, name, args = {}) {
  const result = await session.rpc.tools.execute({ name: `intercom_${name}`, arguments: args })
  const rendered = JSON.stringify(result)
  if (rendered.includes('"resultType":"failure"')) throw new Error(rendered)
  return rendered
}

;(async () => {
  try {
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    options.model = 'gpt-4.1'
    options.provider = {
      type: 'openai', wireApi: 'completions',
      baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`,
    }
    const id = randomUUID()
    let session = await client.createSession({ ...options, sessionId: id })
    await ready(session)
    assert((await tool(session, 'chats')).includes(`copilot:${id}`))
    await tool(session, 'join', { chat: 'isolated-sdk-test', seat: 'SDK-Copilot' })
    assert((await tool(session, 'who', { chat: 'isolated-sdk-test' })).includes('SDK-Copilot'))
    await tool(session, 'send', { chat: 'isolated-sdk-test', body: 'isolated native SDK message' })
    assert((await tool(session, 'history', { chat: 'isolated-sdk-test' })).includes('isolated native SDK message'))
    console.log('PASS: actual installed SDK loads all adapter tools with its real conversation identity')
    console.log('PASS: native tool pipeline joins, lists presence, sends, and reads isolated room history')

    const peer = await client.createSession({ ...options, sessionId: randomUUID() })
    await ready(peer)
    await tool(peer, 'join', { chat: 'isolated-sdk-test', seat: 'SDK-Peer' })
    await tool(peer, 'send', {
      chat: 'isolated-sdk-test', to: 'SDK-Copilot', body: 'native incoming delivery probe',
    })
    let incoming = []
    for (let attempt = 0; attempt < 80; attempt++) {
      incoming = (await session.getEvents()).filter((event) =>
        event.type === 'user.message' && event.data.content.includes('native incoming delivery probe'))
      if (incoming.length) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(incoming.length, 1)
    assert(incoming[0].data.content.includes('not user authorization'))
    assert(!(await peer.getEvents()).some((event) =>
      event.type === 'user.message' && event.data.content.includes('native incoming delivery probe')))
    console.log('PASS: incoming delivery reaches only the owning SDK session event stream')
    for (let attempt = 0; attempt < 80 && !fixtureRequests; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(fixtureRequests, 1)
    console.log('PASS: idle wake invokes only a loopback response fixture, not a real model')

    await session.disconnect()
    session = await client.resumeSession(id, options)
    await ready(session)
    assert((await tool(session, 'chats')).includes('isolated-sdk-test (seat SDK-Copilot)'))
    await tool(session, 'leave', { chat: 'isolated-sdk-test' })
    console.log('PASS: actual SDK resume restores the exact room and seat without a model call')
  } finally {
    const errors = await client.stop()
    await new Promise((resolve) => fixture.close(resolve))
    rmSync(temp, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Native SDK cleanup failed')
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
