import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DesktopRelay as SourceDesktopRelay} from '../codex/desktop-relay.mjs';
import {DesktopIpc as SourceDesktopIpc} from '../codex/desktop-ipc.mjs';
import {nativeHandoff as sourceNativeHandoff} from '../codex/native-handoff.mjs';
import * as data from './chat-db.mjs';
import * as sessions from './session-store.mjs';
import * as delivery from './delivery-state.mjs';
import * as recovery from './sqlite-recovery.mjs';
const lib={DesktopRelay:SourceDesktopRelay,DesktopIpc:SourceDesktopIpc,nativeHandoff:sourceNativeHandoff,...data,...sessions,...delivery,...recovery};
const {DesktopRelay,DesktopIpc,openDb,sendMessage,claimConnection,detachConnection,joinRoom,leaveRoom,attachRooms,getDeliveryCursor,migrateChat,receiptFor}=lib;
let tests=0;
async function test(name,fn){await fn();tests++;console.log('PASS:',name)}
async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'intercom-recovery-')),path=join(dir,'chat.db');
 const db=openDb(path),locker=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=20');locker.exec('PRAGMA busy_timeout=20');
 const identity='codex:'+randomUUID(),bridge=randomUUID(),calls=[];
 let locked=false,relay;
 const lock=()=>{locker.exec('BEGIN IMMEDIATE');locked=true};
 const unlock=()=>{if(locked){locker.exec('ROLLBACK');locked=false}};
 const client={close(){},async deliver(thread,text,guard){assert(guard());calls.push(text);return {turnId:randomUUID(),method:'test-steer'}}};
 try{
  claimConnection(db,identity,'bridge',bridge);attachRooms(db,identity,bridge,null);joinRoom(db,identity,bridge,'room','Receiver');
  relay=new DesktopRelay({db,identity,bridgeConnection:bridge,client});
  const send=(body='payload',chat='room')=>sendMessage(db,chat,'Sender',body,{senderIdentity:'claude:test',toIdentity:identity,toSeat:'Receiver'});
  const tick=async()=>{if(relay.retry)relay.retry.nextAt=0;await relay.tick()};
  await fn({db,locker,identity,bridge,relay,client,calls,lock,unlock,send,tick});
 }finally{unlock();relay?.stop();db.close();locker.close();rmSync(dir,{recursive:true,force:true})}
}
await test('real SQLite write lock does not permanently stop relay; unlock resumes once',()=>fixture(async f=>{
 const id=f.send();f.lock();await f.tick();
 assert.equal(f.relay.stopped,false);assert.equal(f.calls.length,0);f.unlock();await f.tick();await f.tick();
 assert.equal(f.calls.length,1);assert.equal(receiptFor(f.db,f.identity,id).state,'accepted');
}));

await test('SQLite busy/locked classification and bounded backoff exclude unrelated errors',async()=>{
 for(const errcode of [5,6,261,517])assert(lib.isSqliteBusy({errcode}));
 assert(!lib.isSqliteBusy({errcode:11,message:'database is locked'}));
 assert(!lib.isSqliteBusy(new Error('database is locked')));
 let now=0;const r=new lib.SqliteRetry({now:()=>now,random:()=>0.5});
 for(let n=0;n<20;n++){assert(r.defer({errcode:5}));assert(r.nextAt-now<=5000);assert(!r.ready());now=r.nextAt;assert(r.ready())}
 assert(!r.defer({errcode:11}));r.clear();assert.equal(r.failures,0);
});
await test('accepted IPC result survives receipt-write lock without a second submission',()=>fixture(async f=>{
 const id=f.send();f.client.deliver=async(thread,text,guard)=>{assert(guard());f.calls.push(text);f.lock();return {turnId:'accepted-turn',method:'test-steer'}};
 await f.tick();assert.equal(f.relay.stopped,false);assert.equal(f.calls.length,1);
 assert.equal(f.relay.pendingOutcome.state,'accepted');assert.equal(receiptFor(f.db,f.identity,id).state,'submitting');
 await f.tick();assert.equal(f.calls.length,1);f.unlock();await f.tick();await f.tick();
 assert.equal(f.calls.length,1);assert.equal(receiptFor(f.db,f.identity,id).state,'accepted');
 assert.equal(receiptFor(f.db,f.identity,id).turn_id,'accepted-turn');assert.equal(f.relay.pendingOutcome,null);
}));
await test('uncertain outcome remains quarantined even when saving it was locked',()=>fixture(async f=>{
 const id=f.send();f.client.deliver=async(thread,text,guard)=>{assert(guard());f.calls.push(text);f.lock();throw new Error('response timed out')};
 await f.tick();assert.equal(f.relay.pendingOutcome.state,'uncertain');f.unlock();await f.tick();f.send('later');await f.tick();
 assert.equal(f.calls.length,1);assert.equal(receiptFor(f.db,f.identity,id).state,'uncertain');
}));
await test('already accepted/submitting/uncertain persisted messages are never resubmitted',()=>fixture(async f=>{
 const a=f.send('accepted'),b=f.send('unknown');
 f.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?,?,?)').run(f.identity,a,'room','accepted','turn','prior',Date.now());
 f.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?,?,?,?)').run(f.identity,b,'room','submitting',null,'prior',Date.now());
 await f.tick();await f.tick();assert.equal(f.calls.length,0);assert.equal(getDeliveryCursor(f.db,'room',f.identity,'codex-app-server'),a);
 f.db.prepare("UPDATE delivery_receipts SET state='uncertain' WHERE message_id=?").run(b);await f.tick();assert.equal(f.calls.length,0);
}));
await test('heartbeat lock and lease expiry recover only the same connection IDs',()=>fixture(async f=>{
 const id=f.send();f.lock();f.relay.heartbeatTick();assert.equal(f.relay.stopped,false);f.unlock();
 f.db.prepare('UPDATE connection_leases SET expires_at=0 WHERE identity=?').run(f.identity);
 await f.tick();assert.equal(f.calls.length,1);assert.equal(receiptFor(f.db,f.identity,id).state,'accepted');
}));
await test('replacement owner fences old relay after lock; no takeover or delivery',()=>fixture(async f=>{
 f.send();f.lock();await f.tick();f.unlock();
 const replacement=randomUUID();f.db.prepare("UPDATE connection_leases SET connection_id=? WHERE identity=? AND role='bridge'").run(replacement,f.identity);
 await f.tick();assert(f.relay.stopped);assert.equal(f.calls.length,0);
 assert.equal(f.db.prepare("SELECT connection_id FROM connection_leases WHERE identity=? AND role='bridge'").get(f.identity).connection_id,replacement);
}));
await test('successful response with changed attempt owner is not sent again',()=>fixture(async f=>{
 const id=f.send();f.client.deliver=async(thread,text,guard)=>{assert(guard());f.calls.push(text);f.lock();return{turnId:'t',method:'test'}};
 await f.tick();f.unlock();f.db.prepare("UPDATE delivery_attempts SET attempt_id='replacement' WHERE message_id=?").run(id);
 await f.tick();assert(f.relay.stopped);assert.equal(f.calls.length,1);assert.equal(receiptFor(f.db,f.identity,id).state,'submitting');
}));
await test('IPC guard lock is explicitly not submitted, including idle fallback guard',async()=>{
 const id=randomUUID();
 for(const idle of [false,true]){
  const c=new DesktopIpc();let sends=0,guards=0;c.connect=async()=>{};c.close=()=>{};
  c.request=async(method)=>{
   if(method==='thread-owner-discovery')return{handledByClientId:randomUUID()};
   sends++;throw new Error(`Cannot steer conversation ${id} because its active turn already ended`);
  };
  const err=await c.deliver(id,'test',()=>{guards++;if(!idle||guards===2)throw Object.assign(new Error('busy'),{errcode:5});return true}).catch(e=>e);
  assert.equal(err.notSubmitted,true);assert.equal(sends,idle?1:0);
 }
});
await test('explicit idle rejection followed by DB lock retains not-submitted classification',async()=>{
 const id=randomUUID(),c=new DesktopIpc();let sends=0;c.connect=async()=>{};c.close=()=>{};
 c.request=async method=>{if(method==='thread-owner-discovery')return{handledByClientId:randomUUID()};sends++;throw new Error(`Cannot steer conversation ${id} because its active turn already ended`)};
 const e=await c.deliver(id,'test',()=>true,()=>{throw Object.assign(new Error('busy'),{errcode:5})}).catch(e=>e);
 assert.equal(e.notSubmitted,true);assert.equal(sends,1);
});
await test('room leave and rename during receipt persistence preserve membership and cursors',()=>fixture(async f=>{
 const id=f.send();f.client.deliver=async(thread,text,guard)=>{assert(guard());f.calls.push(text);f.lock();return{turnId:'t',method:'test'}};
 await f.tick();f.unlock();migrateChat(f.db,'room','renamed');await f.tick();
 assert.equal(receiptFor(f.db,f.identity,id).chat,'renamed');assert.equal(getDeliveryCursor(f.db,'renamed',f.identity,'codex-app-server'),id);
 const id2=f.send('second','renamed');await f.tick();f.unlock();leaveRoom(f.db,f.identity,f.bridge,'renamed');await f.tick();
 assert.equal(receiptFor(f.db,f.identity,id2).state,'accepted');assert.equal(getDeliveryCursor(f.db,'renamed',f.identity,'codex-app-server'),null);assert.equal(f.calls.length,2);
}));
await test('fatal non-lock error still stops instead of indefinite retry',()=>fixture(async f=>{
 f.db.prepare("DELETE FROM connection_leases WHERE identity=? AND role='bridge'").run(f.identity);await f.tick();assert(f.relay.stopped);
}));
console.log(`${tests} recovery tests passed`);
