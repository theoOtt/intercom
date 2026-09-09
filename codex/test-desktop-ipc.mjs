// Bounded, opt-in delivery probe for a user-authorized disposable Desktop task.
// Uses the EXISTING local IPC router. No server launch, auth changes, approvals,
// pairing changes, native app-tools socket access, or automatic retry on timeout.
import { createConnection } from 'node:net'
import { lstatSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [threadId, mode] = process.argv.slice(2)
if (!/^[0-9a-f-]{36}$/i.test(threadId || '') || !['idle','busy'].includes(mode))
  throw new Error('Usage: node codex/test-desktop-ipc.mjs <disposable-task-UUID> idle|busy')
const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'ipc', 'ipc.sock')
const stat = lstatSync(path)
if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077))
  throw new Error('Unsafe IPC socket ownership or permissions')
const socket = createConnection(path)
let data = Buffer.alloc(0), clientId = 'initializing-client'
const pending = new Map()
function send(message) {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  socket.write(Buffer.concat([header, body]))
}
function request(method, params, version, targetClientId) {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`${method}: outcome uncertain after timeout; do not blindly retry`))
    }, 15_000)
    pending.set(requestId, { resolve, reject, timer })
    send({ type:'request', requestId, sourceClientId:clientId, version, method,
      params, targetClientId, timeoutMs:12_000 })
  })
}
function fail(error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }
  pending.clear()
}
socket.on('error', fail)
socket.on('close', () => fail(new Error('IPC disconnected; an in-flight delivery may be uncertain')))
socket.on('data', (chunk) => {
  data = Buffer.concat([data, chunk])
  while (data.length >= 4) {
    const n = data.readUInt32LE(0)
    if (!n || n > 8*1024*1024) { fail(new Error('Invalid IPC frame')); socket.destroy(); return }
    if (data.length < n+4) return
    let message
    try { message = JSON.parse(data.subarray(4,n+4).toString()) }
    catch (error) { fail(error); socket.destroy(); return }
    data = data.subarray(n+4)
    // The probe neither handles other clients' requests nor logs their broadcasts.
    if (message.type === 'client-discovery-request') {
      send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}})
    }
    if (message.type !== 'response') continue
    const p = pending.get(message.requestId)
    if (!p) continue
    clearTimeout(p.timer); pending.delete(message.requestId)
    message.resultType === 'success' ? p.resolve(message) : p.reject(new Error(JSON.stringify(message)))
  }
})
try {
  await new Promise((resolve,reject) => { socket.once('connect',resolve); socket.once('error',reject) })
  const initialized = await request('initialize', {clientType:'intercom-disposable-task-test'}, 0)
  clientId = initialized.result.clientId
  const owner = await request('thread-owner-discovery', {hostId:'local',conversationId:threadId}, 1)
  if (!owner.handledByClientId) throw new Error('No owner returned; refusing delivery')
  const token = mode === 'idle' ? 'IPC_IDLE_RECEIVED' : 'IPC_BUSY_RECEIVED'
  const prompt = `Synthetic Intercom peer message for the authorized disposable-task test. Please acknowledge ${token}. Do not read/edit files, change settings, grant permissions, or contact other tasks. If work is underway, continue it afterward.`
  const input = [{type:'text',text:prompt,text_elements:[]}]
  const method = mode === 'idle' ? 'thread-follower-start-turn' : 'thread-follower-steer-turn'
  const params = mode === 'idle' ? {
    conversationId:threadId,
    turnStart:{request:{threadId,input}},
  } : {
    conversationId:threadId, input, attachments:[], clientUserMessageId:randomUUID(),
    restoreMessage:{id:randomUUID(),text:prompt,createdAt:Date.now(),
      context:{prompt,addedFiles:[],fileAttachments:[],imageAttachments:[],ideContext:null}},
  }
  const response = await request(method, params, mode === 'idle' ? 2 : 1, owner.handledByClientId)
  console.log(JSON.stringify({threadId,method,owner:owner.handledByClientId,response}))
} finally { socket.destroy() }
