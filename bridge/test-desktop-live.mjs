// Live opt-in test against one explicitly authorized disposable Desktop task.
// Temporary Intercom DB; existing Desktop runtime; no production-room writes.
import assert from 'node:assert/strict'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createInterface} from 'node:readline'
import {openDb} from './chat-db.mjs'
const thread=process.argv[2]
assert(/^[0-9a-f-]{36}$/i.test(thread||''),'Pass an authorized disposable task UUID')
const dir=mkdtempSync(join(tmpdir(),'intercom-desktop-live-')),dbPath=join(dir,'chat.db')
const db=openDb(dbPath),clients=[]
const metadata={'x-codex-turn-metadata':JSON.stringify({thread_id:thread})}
const text=r=>r.content.map(i=>i.text||'').join('\n')
async function session(recipient){
 const c=new Client({name:recipient?'codex-mcp-client':'intercom-live-test-peer',version:'1.0'})
 const t=new StdioClientTransport({command:process.execPath,args:[resolve('plugins/intercom/dist/bridge.mjs')],
  env:{PATH:process.env.PATH,HOME:process.env.HOME,CHAT_DB:dbPath,CHAT_AUTOJOIN_PROJECT:'0',
   ...(recipient?{}:{CHAT_IDENTITY:'claude:desktop-live-peer'})},stderr:'pipe'})
 t.stderr.on('data',b=>process.stderr.write(b))
 await c.connect(t);clients.push(c)
 return {client:c,call:(name,args={})=>c.callTool({name,arguments:args,...recipient?{_meta:metadata}:{}})}
}
async function accepted(id){
 const end=Date.now()+30_000
 while(Date.now()<end){
  const row=db.prepare('SELECT state,detail,turn_id FROM delivery_receipts WHERE identity=? AND message_id=?').get(`codex:${thread}`,id)
  if(row?.state==='accepted'){console.log(JSON.stringify({accepted:id,...row}));return}
  if(row?.state==='uncertain')throw Error(JSON.stringify(row))
  await new Promise(r=>setTimeout(r,200))
 }
 throw Error('Delivery did not become accepted')
}
let recipient,peer
async function send(chat,body,to){
 await peer.call('send',{chat,body,...to?{to}:{}})
 const {id}=db.prepare('SELECT max(id) id FROM messages').get()
 await accepted(id)
}
try{
 recipient=await session(true);peer=await session(false)
 await recipient.call('join',{chat:'ipc-auto-one',seat:'Desktop-A'})
 await recipient.call('join',{chat:'ipc-auto-two',seat:'Desktop-B'})
 await peer.call('join',{chat:'ipc-auto-one',seat:'Peer'})
 await peer.call('join',{chat:'ipc-auto-two',seat:'Peer'})
 await send('ipc-auto-one','AUTO_IDLE_TOKEN — synthetic test; please surface this token.','Desktop-A')
 console.log('READY: idle sent. stdin commands: busy, reconnect, leave, stop')
 const lines=createInterface({input:process.stdin})
 const timeout=setTimeout(()=>lines.close(),600_000)
 for await(const line of lines){
  if(line.trim()==='stop')break
  if(line.trim()==='busy')await send('ipc-auto-two','AUTO_BUSY_TOKEN — synthetic test; please surface this token and continue the original task.','Desktop-B')
  if(line.trim()==='reconnect'){
   await recipient.client.close()
   await peer.call('send',{chat:'ipc-auto-two',body:'AUTO_RECONNECT_TOKEN — queued while bridge disconnected; please surface this token.'})
   const {id}=db.prepare('SELECT max(id) id FROM messages').get()
   recipient=await session(true)
   const rooms=text(await recipient.call('chats'))
   assert.match(rooms,/ipc-auto-one \(seat Desktop-A\)/);assert.match(rooms,/ipc-auto-two \(seat Desktop-B\)/)
   console.log('RESTORED: exact room/seat names without join calls')
   await accepted(id)
  }
  if(line.trim()==='leave'){
   await recipient.call('leave',{chat:'ipc-auto-two'})
   await peer.call('send',{chat:'ipc-auto-two',body:'MUST_NOT_DELIVER_AFTER_LEAVE'})
   const {id}=db.prepare('SELECT max(id) id FROM messages').get()
   await new Promise(r=>setTimeout(r,2000))
   assert(!db.prepare('SELECT 1 FROM delivery_receipts WHERE identity=? AND message_id=?').get(`codex:${thread}`,id))
   console.log('PASS: left-room message was not delivered')
  }
  console.log('READY')
 }
 clearTimeout(timeout);lines.close()
}finally{
 for(const c of clients)await c.close().catch(()=>{})
 db.close();rmSync(dir,{recursive:true,force:true})
 console.log('Live-test bridges stopped and temporary chat database removed; Desktop task remains available.')
}
