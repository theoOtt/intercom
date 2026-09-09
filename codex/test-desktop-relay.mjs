import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,sendMessage,getDeliveryCursor,migrateChat} from '../bridge/chat-db.mjs'
import {claimConnection,detachConnection,joinRoom,leaveRoom,attachRooms} from '../bridge/session-store.mjs'
import {DesktopRelay} from './desktop-relay.mjs'

const dir=mkdtempSync(join(tmpdir(),'desktop-relay-unit-')),db=openDb(join(dir,'chat.db'))
const identity=`codex:${randomUUID()}`,other=`codex:${randomUUID()}`
let bridge=randomUUID(),relay
const calls=[]
let failure=null,before=null
const client={close(){},async deliver(thread,text,guard){
  before?.(); if(!guard()) throw Object.assign(new Error('left'),{notSubmitted:true})
  if(failure) throw failure
  calls.push({thread,text}); return {turnId:randomUUID(),method:'test-steer'}
}}
const message=(chat,body,who=identity)=>sendMessage(db,chat,'peer',body,{senderIdentity:'claude:test-peer',toIdentity:who,toSeat:'Reviewer'})
try {
  claimConnection(db,identity,'bridge',bridge)
  attachRooms(db,identity,bridge,null)
  joinRoom(db,identity,bridge,'one','Reviewer'); joinRoom(db,identity,bridge,'two','Second')
  relay=new DesktopRelay({db,identity,bridgeConnection:bridge,client})
  assert.throws(()=>new DesktopRelay({db,identity,bridgeConnection:bridge,client}),/already has a live/)
  message('two','first');message('one','second');message('one','hidden',other)
  await relay.tick();await relay.tick();await relay.tick()
  assert.equal(calls.length,2);assert.match(calls[0].text,/first/);assert.match(calls[1].text,/second/)
  const id=message('one','offline')
  failure=Object.assign(new Error('no owner'),{notSubmitted:true})
  await relay.tick()
  assert.equal(db.prepare('SELECT state FROM delivery_receipts WHERE message_id=?').get(id).state,'pending')
  failure=null;await relay.tick();assert.equal(calls.length,3)
  const uncertain=message('one','timeout')
  failure=new Error('timeout');await relay.tick();failure=null;await relay.tick()
  assert.equal(calls.length,3)
  assert.equal(db.prepare('SELECT state FROM delivery_receipts WHERE message_id=?').get(uncertain).state,'uncertain')
  // Explicit test reconciliation (not automatic production behavior).
  db.prepare("UPDATE delivery_receipts SET state='accepted' WHERE message_id=?").run(uncertain)
  await relay.tick();assert.equal(getDeliveryCursor(db,'one',identity,'codex-app-server'),uncertain)
  message('two','leave-during-discovery')
  before=()=>leaveRoom(db,identity,bridge,'two');await relay.tick();before=null
  assert.equal(calls.length,3);assert.equal(getDeliveryCursor(db,'two',identity,'codex-app-server'),null)
  message('one','rename-in-flight')
  client.deliver=async(thread,text,guard)=>{
    assert(guard());migrateChat(db,'one','renamed');calls.push({thread,text})
    return {turnId:randomUUID(),method:'test-start'}
  }
  await relay.tick();await relay.tick();assert.equal(calls.length,4)
  relay.stop();detachConnection(db,identity,'bridge',bridge)
  bridge=randomUUID();claimConnection(db,identity,'bridge',bridge)
  assert.deepEqual(attachRooms(db,identity,bridge,'unrelated'),[])
  assert.equal(db.prepare('SELECT seat FROM seats WHERE identity=? AND chat=?').get(identity,'renamed').seat,'Reviewer')
  relay=new DesktopRelay({db,identity,bridgeConnection:bridge,client})
  await relay.tick();assert.equal(calls.length,4)
  db.prepare("UPDATE connection_leases SET expires_at=0 WHERE identity=? AND role='bridge'").run(identity)
  await relay.tick();assert(relay.stopped)
  console.log('PASS: Desktop relay multiroom order, direct filtering, offline retry, uncertain pause, leave/rename races, exact-name restore, duplicates and stale fencing')
} finally {relay?.stop();db.close();rmSync(dir,{recursive:true,force:true})}
