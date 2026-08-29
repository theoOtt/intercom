#!/usr/bin/env node
// Launch a dedicated local Codex App Server, attach the visible TUI, and run the
// Intercom wake relay against the one thread loaded in that server.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CodexRelay } from './relay.mjs'

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const safeChat = (value) => (value || 'project').replace(/[^a-zA-Z0-9._-]/g, '-')

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const own = separator >= 0 ? argv.slice(0, separator) : argv
  const codexArgs = separator >= 0 ? argv.slice(separator + 1) : []
  const value = (name, fallback) => {
    const index = own.indexOf(name)
    return index >= 0 ? own[index + 1] : fallback
  }
  const cwd = resolve(value('--cwd', process.cwd()))
  return {
    cwd,
    chat: safeChat(value('--chat', basename(cwd))),
    seat: value('--seat', 'codex'),
    dbPath: resolve(value('--db', join(homedir(), '.claude', 'intercom', 'chat.db'))),
    port: value('--port', null),
    codexArgs,
  }
}

function resumedThreadId(args) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === 'resume' && args[index + 1]?.match(/^[0-9a-f-]{36}$/i)) return args[index + 1]
    if ((args[index] === '--resume' || args[index] === '-r') && args[index + 1]?.match(/^[0-9a-f-]{36}$/i)) {
      return args[index + 1]
    }
  }
  return null
}

async function freePort(requested) {
  if (requested) return Number(requested)
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePromise(address.port))
    })
  })
}

async function waitReady(port, child) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Codex App Server exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`)
      if (response.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('Codex App Server did not become ready within 15 seconds')
}

const options = parseArgs(process.argv.slice(2))
const port = await freePort(options.port)
const endpoint = `ws://127.0.0.1:${port}`
const knownThreadId = resumedThreadId(options.codexArgs)
const provisionalIdentity = knownThreadId ? `codex:${knownThreadId}` : `codex-startup:${randomUUID()}`
const runtimeDir = join(tmpdir(), 'intercom-codex')
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
const identityFile = join(runtimeDir, `${process.pid}-${randomUUID()}.identity`)
writeFileSync(identityFile, `${provisionalIdentity}\n`, { mode: 0o600 })

const childEnv = {
  ...process.env,
  CHAT_DB: options.dbPath,
  CHAT: options.chat,
  SEAT: options.seat,
  CHAT_IDENTITY_FILE: identityFile,
}

// Codex intentionally controls the environment inherited by MCP subprocesses.
// Pass the per-session values as explicit MCP config overrides so they reach the
// bridge regardless of shell_environment_policy.
const mcpEnvironment = {
  CHAT_DB: options.dbPath,
  CHAT_AUTOJOIN_PROJECT: '1',
  CHAT: options.chat,
  SEAT: options.seat,
  CHAT_IDENTITY_FILE: identityFile,
}
const appServerArgs = ['app-server', '--listen', endpoint]
for (const [name, value] of Object.entries(mcpEnvironment)) {
  appServerArgs.push('-c', `mcp_servers.intercom.env.${name}=${JSON.stringify(value)}`)
}

const appServer = spawn('codex', appServerArgs, {
  cwd: options.cwd,
  env: childEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
appServer.stderr.on('data', (chunk) => process.stderr.write(`[codex-app-server] ${chunk}`))

let tui = null
let relay = null
let shuttingDown = false
function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  relay?.stop()
  if (tui && tui.exitCode === null) tui.kill('SIGTERM')
  if (appServer.exitCode === null) {
    try { process.kill(-appServer.pid, 'SIGTERM') } catch {}
  }
  try { rmSync(identityFile, { force: true }) } catch {}
  process.exitCode = exitCode
}
process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

try {
  await waitReady(port, appServer)
  process.stderr.write(
    `[intercom] Codex session chat="${options.chat}" requested-seat="${options.seat}" endpoint=${endpoint}\n`
  )

  relay = new CodexRelay({
    endpoint,
    dbPath: options.dbPath,
    chat: options.chat,
    identityFile,
    threadId: knownThreadId,
  })
  const relayRun = relay.start().catch((error) => {
    process.stderr.write(`[intercom] relay failed: ${error.stack || error}\n`)
    shutdown(1)
  })

  const hasCwd = options.codexArgs.some((arg) => arg === '-C' || arg === '--cd')
  const args = ['--remote', endpoint]
  if (!hasCwd) args.push('-C', options.cwd)
  args.push(...options.codexArgs)
  tui = spawn('codex', args, { cwd: options.cwd, env: childEnv, stdio: 'inherit' })
  const exitCode = await new Promise((resolvePromise) => tui.once('exit', (code) => resolvePromise(code ?? 1)))
  relay.stop()
  await Promise.race([relayRun, sleep(1000)])
  shutdown(exitCode)
} catch (error) {
  process.stderr.write(`[intercom] launch failed: ${error.stack || error}\n`)
  shutdown(1)
}
