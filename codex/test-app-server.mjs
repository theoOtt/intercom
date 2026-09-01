// Smoke-test this installed Codex version's real WebSocket App Server transport.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { AppServerClient } from './app-server-client.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const port = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => resolve(address.port))
  })
})
const endpoint = `ws://127.0.0.1:${port}`
const server = spawn('codex', ['app-server', '--listen', endpoint], {
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
let stderr = ''
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
  const client = new AppServerClient(endpoint, { clientName: 'intercom_smoke_test' })
  await client.connect()
  const result = await client.request('thread/loaded/list', { limit: 5 })
  if (!Array.isArray(result.data)) throw new Error('thread/loaded/list returned an invalid result')
  process.stdout.write('PASS: connected, initialized, and queried the real Codex App Server\n')
  client.close()
} catch (error) {
  throw new Error(`${error.message}\nApp Server stderr:\n${stderr}`)
} finally {
  try { process.kill(-server.pid, 'SIGTERM') } catch {}
  if (server.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => server.once('exit', resolvePromise)),
      sleep(2_000),
    ])
  }
  if (server.exitCode === null) {
    try { process.kill(-server.pid, 'SIGKILL') } catch {}
  }
}
