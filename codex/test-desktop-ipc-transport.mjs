import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {mkdtempSync,chmodSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DesktopIpc} from './desktop-ipc.mjs'
const dir=mkdtempSync(join(tmpdir(),'ipc-transport-')),path=join(dir,'ipc.sock'),thread=randomUUID(),owner=randomUUID()
let idle=true,mode='normal',calls=[]
const server=createServer(s=>{
 let buffer=Buffer.alloc(0)
 s.on('data',b=>{
  buffer=Buffer.concat([buffer,b])
  while(buffer.length>=4){const n=buffer.readUInt32LE(0);if(buffer.length<n+4)return
   const m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4)
   if(m.type!=='request')continue
   calls.push(m.method)
   const r={type:'response',requestId:m.requestId,method:m.method,resultType:'success',handledByClientId:owner}
   if(m.method==='initialize')r.result={clientId:randomUUID()}
   else if(m.method==='thread-owner-discovery') {
    if(mode==='offline'){r.resultType='error';r.error='no-client-found'}else r.result={}
   } else {
    assert.equal(m.targetClientId,owner);assert.equal(m.params.conversationId,thread)
    if(mode==='disconnect'){s.destroy();return}
    if(idle && m.method==='thread-follower-steer-turn'){r.resultType='error';r.error=`Cannot steer conversation ${thread} because its active turn already ended`}
    else r.result={result:{turnId:'accepted-turn'}}
   }
   const body=Buffer.from(JSON.stringify(r)),h=Buffer.alloc(4);h.writeUInt32LE(body.length)
   s.write(h.subarray(0,2));s.write(Buffer.concat([h.subarray(2),body]))
  }
 })
})
await new Promise(r=>server.listen(path,r));chmodSync(path,0o600)
const client=new DesktopIpc({socketPath:path,timeoutMs:1000})
try{
 let result=await client.deliver(thread,'idle',()=>true)
 assert.equal(result.method,'thread-follower-start-turn')
 idle=false;calls=[];result=await client.deliver(thread,'busy',()=>true)
 assert.equal(result.method,'thread-follower-steer-turn');assert(!calls.includes('thread-follower-start-turn'))
 mode='offline';await assert.rejects(client.deliver(thread,'offline',()=>true),e=>e.notSubmitted===true)
 mode='normal';calls=[];await assert.rejects(client.deliver(thread,'left',()=>false),e=>e.notSubmitted===true)
 assert(!calls.includes('thread-follower-steer-turn'))
 mode='disconnect';await assert.rejects(client.deliver(thread,'uncertain',()=>true),e=>!e.notSubmitted)
 console.log('PASS: real IPC framing, owner targeting, idle fallback, busy steering, no-owner retry, guard cancellation and ambiguous disconnect')
}finally{client.close();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
