// Optional live Claude Code integration test. This intentionally makes two
// small model calls, so it only runs when explicitly enabled.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { history, openDb } from './chat-db.mjs'

if (process.env.INTERCOM_LIVE_CLAUDE_TEST !== '1') {
  process.stdout.write('SKIP: set INTERCOM_LIVE_CLAUDE_TEST=1 to run the live Claude identity test\n')
  process.exit(0)
}

const temp = mkdtempSync(join(tmpdir(), 'intercom-claude-live-'))
const dbPath = join(temp, 'chat.db')
const configPath = join(temp, 'mcp.json')
const bridgePath = resolve('bridge/bridge.mjs')
const pluginMode = process.env.INTERCOM_TEST_CLAUDE_PLUGIN === '1'
const sessionId = randomUUID()
const chat = `claude-identity-${sessionId}`
writeFileSync(configPath, `${JSON.stringify({
  mcpServers: {
    intercom: {
      command: 'node',
      args: [bridgePath],
      env: { CHAT_DB: dbPath, CHAT: chat, SEAT: 'claude-test' },
    },
  },
}, null, 2)}\n`)

function runClaude(sessionArgs, body) {
  const integrationArgs = pluginMode
    ? ['--channels', 'plugin:intercom@intercom', '--tools', 'default']
    : [
        '--mcp-config', configPath,
        '--strict-mcp-config',
        '--dangerously-load-development-channels', 'server:intercom',
        '--tools', 'mcp__intercom__send',
      ]
  const args = [
    '-p',
    ...sessionArgs,
    ...integrationArgs,
    '--permission-mode', 'bypassPermissions',
    '--model', 'haiku',
    '--max-budget-usd', '0.20',
    '--output-format', 'json',
    `Call the Intercom send tool exactly once with chat "${chat}" and body "${body}". Do nothing else.`,
  ]
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env, CHAT_DB: dbPath, CHAT: chat, SEAT: 'claude-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Claude live identity test timed out'))
    }, 120_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`Claude exited ${code}\n${stderr}\n${stdout}`))
    })
  })
}

try {
  await runClaude(['--session-id', sessionId], 'initial identity probe')
  await runClaude(['--resume', sessionId], 'resumed identity probe')

  const db = openDb(dbPath)
  const rows = history(db, chat, { limit: 10 })
    .filter((row) => row.body?.endsWith('identity probe'))
  db.close()
  if (rows.length !== 2) throw new Error(`Expected two messages, observed ${JSON.stringify(rows)}`)
  const expected = `claude:${sessionId}`
  if (rows.some((row) => row.sender_identity !== expected)) {
    throw new Error(`Expected both messages from ${expected}, observed ${JSON.stringify(rows)}`)
  }
  process.stdout.write(
    `PASS: a resumed Claude Code session retained its UUID-backed Intercom identity` +
    (pluginMode ? ' through the marketplace channel plugin' : '') + '\n'
  )
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
