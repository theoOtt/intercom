// Isolated source/packaged MCP and vendor-hook contract tests. No real Claude.
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,watch,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {openDb,sendMessage,getDeliveryCursor} from './chat-db.mjs';
import {claimConnection,attachRooms,joinRoom,atomic} from './session-store.mjs';
import {attachRoute,route,reserve,receiveProof,acknowledge,hookConfig,closeRoute} from '../claude/delivery.mjs';
const root = mkdtempSync(join(tmpdir(),'intercom-claude-hooks-'));
const hookPath = process.env.INTERCOM_CLAUDE_HOOK_PATH || new URL('../claude/hook.mjs',import.meta.url).pathname;
const configurePath = process.env.INTERCOM_CLAUDE_CONFIGURE_PATH || new URL('../claude/configure.mjs',import.meta.url).pathname;
const bridgePath = process.env.INTERCOM_BRIDGE_PATH || new URL('./bridge.mjs',import.meta.url).pathname;
const output = proof => ({content:[{type:'text',text:JSON.stringify({intercom_receive:proof})}]});
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS:',name);}
async function fixture(fn){
  const dir=mkdtempSync(join(root,'case-')),database=join(dir,'chat.db'),file=join(dir,'config.json'),stateDir=join(dir,'waiters');
  mkdirSync(stateDir,{mode:0o700});
  const db=openDb(database),id=randomUUID(),identity='claude:'+id,connection=randomUUID();
  const config={version:1,enabled:true,transport:'hooks',database,stateDir,generation:randomUUID(),afterMessageId:0,waitTimeoutMs:1500};
  const save=()=>writeFileSync(file,JSON.stringify(config),{mode:0o600});save();
  const env={PATH:process.env.PATH,HOME:dir,CHAT_DB:database,CHAT:'room',CLAUDE_CODE_SESSION_ID:id,
    INTERCOM_CLAUDE_TRANSPORT:'hooks',INTERCOM_CLAUDE_DELIVERY_CONFIG:file};
  const bind=()=>{claimConnection(db,identity,'bridge',connection);attachRooms(db,identity,connection,null);joinRoom(db,identity,connection,'room','Receiver');joinRoom(db,identity,connection,'other','Elsewhere');attachRoute(db,identity,connection,config);};
  const children=[],clients=[];
  const event=(extra={})=>({hook_event_name:'UserPromptSubmit',session_id:id,...extra});
  const run=(e,overrides={})=>spawnSync(process.execPath,[hookPath],{input:JSON.stringify(e),env:{...env,...overrides},encoding:'utf8',timeout:5000});
  const wait=e=>{
    const child=spawn(process.execPath,[hookPath],{env,stdio:['pipe','pipe','pipe']});children.push(child);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.stdin.end(JSON.stringify(e));
    const completed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('hook exceeded fixture bound'));},5000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
    return {child,completed};
  };
  const armed=()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{w.close();reject(Error('hook did not arm'));},2000);
    const ready=()=>{if(readdirSync(stateDir).length){clearTimeout(timer);w.close();resolve();}};
    const w=watch(stateDir,ready);ready();
  });
  const send=(body='UNTRUSTED_PEER_BODY',options={})=>sendMessage(db,options.chat||'room','UNTRUSTED_PEER_SEAT',body,
    {senderIdentity:options.sender||'claude:'+randomUUID(),toIdentity:options.target===undefined?identity:options.target,toSeat:options.target===null?null:'Receiver'});
  const receipt=message=>db.prepare('SELECT * FROM delivery_receipts WHERE identity=? AND message_id=?').get(identity,message);
  const mcp=async(overrides={})=>{
    const client=new Client({name:'claude-code',version:'fixture'}),transport=new StdioClientTransport({command:process.execPath,args:[bridgePath],env:{...env,...overrides},stderr:'pipe'});
    transport.stderr.on('data',()=>{});await client.connect(transport);clients.push(client);return client;
  };
  try{await fn({db,id,identity,connection,config,save,env,event,run,wait,armed,send,receipt,bind,mcp,file,database});}
  finally{for(const c of clients)await c.close();for(const c of children)if(c.exitCode===null){c.kill('SIGTERM');await new Promise(r=>c.once('exit',r));}db.close();rmSync(dir,{recursive:true,force:true});}
}
try{
  await test('channel remains default; unknown explicit mode fails closed',()=>{
    const old=process.env.INTERCOM_CLAUDE_TRANSPORT;
    delete process.env.INTERCOM_CLAUDE_TRANSPORT;assert.equal(hookConfig(),null);
    process.env.INTERCOM_CLAUDE_TRANSPORT='guess-desktop';assert.throws(()=>hookConfig(),/Unknown explicit/);
    if(old===undefined)delete process.env.INTERCOM_CLAUDE_TRANSPORT;else process.env.INTERCOM_CLAUDE_TRANSPORT=old;
  });
  await test('host root identity and active selected bridge required; subagent and fork rejected',()=>fixture(async f=>{
    f.bind();assert.equal(f.run(f.event({agent_id:randomUUID()})).status,0);
    assert.equal(f.run(f.event({session_id:randomUUID()})).status,0);
    assert.equal(f.run(f.event({session_id:'Receiver'})).status,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM delivery_receipts').get().n,0);
  }));
  await test('event-driven idle hook exits 2 with only fixed numeric notice; duplicate waiter exits',()=>fixture(async f=>{
    f.bind();const waiter=f.wait(f.event({hook_event_name:'Stop'}));await f.armed();
    assert.equal(f.run(f.event()).status,0);
    const id=f.send();const result=await waiter.completed;
    assert.equal(result.code,2,result.stderr);assert.equal(result.stdout,'');assert.match(result.stderr,new RegExp('message_id='+id));
    assert.doesNotMatch(result.stderr,/UNTRUSTED/);assert.equal(f.receipt(id).state,'submitting');
    assert.equal(getDeliveryCursor(f.db,'room',f.identity,'claude-channel'),0);
  }));
  await test('one reserved item across rooms; private recipients/self/ambiguous legacy routes excluded',()=>fixture(async f=>{
    f.bind();f.send('hidden',{target:'claude:'+randomUUID()});f.send('self',{sender:f.identity});
    f.db.prepare("INSERT INTO messages(chat,seat,sender_identity,to_seat,body,ts) VALUES('room','old-peer','old','Receiver','legacy','now')").run();
    const broadcast=f.send('broadcast',{target:null,chat:'other'}),next=f.send('next');
    const current=route(f.db,f.identity,f.config);
    assert.equal(atomic(f.db,()=>reserve(f.db,f.identity,current)),broadcast);
    assert.equal(atomic(f.db,()=>reserve(f.db,f.identity,current)),null);assert.equal(f.receipt(next),undefined);
  }));
  await test('exact namespaced receive input/output token required; forged or wrong input never acknowledges',()=>fixture(async f=>{
    f.bind();const id=f.send(),current=route(f.db,f.identity,f.config);atomic(f.db,()=>reserve(f.db,f.identity,current));
    const row=f.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    const proof={reader_identity:f.identity,message_id:id,...receiveProof(f.db,f.identity,f.connection,f.config,row)};
    const event=f.event({hook_event_name:'PostToolUse',tool_name:'mcp__plugin_intercom_intercom__receive',tool_input:{message_id:id},tool_response:output(proof)});
    for(const bad of [{...event,tool_name:'mcp__other__receive'},{...event,tool_input:{message_id:id+1}},
      {...event,tool_response:output({...proof,claude_hook:{...proof.claude_hook,token:randomUUID()}})},
      {...event,tool_response:{...event.tool_response,isError:true}}])assert.equal(atomic(f.db,()=>acknowledge(f.db,f.identity,current,bad)),false);
    assert.equal(f.receipt(id).state,'submitting');assert.equal(atomic(f.db,()=>acknowledge(f.db,f.identity,current,event)),true);
    assert.equal(f.receipt(id).state,'accepted');assert.equal(getDeliveryCursor(f.db,'room',f.identity,'claude-channel'),id);
    assert.equal(atomic(f.db,()=>acknowledge(f.db,f.identity,current,event)),false);
  }));
  await test('real MCP receive proof acknowledges and next room wakes; channel notifications suppressed',()=>fixture(async f=>{
    const client=await f.mcp();const notices=[];client.fallbackNotificationHandler=n=>notices.push(n);
    await client.callTool({name:'join',arguments:{chat:'room',seat:'Receiver'}});
    await client.callTool({name:'join',arguments:{chat:'other',seat:'Elsewhere'}});
    const waiter=f.wait(f.event({hook_event_name:'PreToolUse'}));await f.armed();const first=f.send();
    const woke=await waiter.completed;assert.equal(woke.code,2,woke.stderr);
    const response=await client.callTool({name:'receive',arguments:{message_id:first}});
    assert.match(response.content[0].text,/UNTRUSTED_PEER_BODY/);assert(response.structuredContent.intercom_receive.claude_hook.token);
    const second=f.send('SECOND_UNTRUSTED',{chat:'other'});
    const acknowledged=f.run(f.event({hook_event_name:'PostToolUse',tool_name:'mcp__plugin_intercom_intercom__receive',tool_input:{message_id:first},tool_response:response}));
    assert.equal(acknowledged.status,2,acknowledged.stderr);assert.match(acknowledged.stderr,new RegExp('message_id='+second));assert.doesNotMatch(acknowledged.stderr,/UNTRUSTED/);
    assert.equal(f.receipt(first).state,'accepted');assert.equal(f.receipt(second).state,'submitting');
    // Exercise the existing 1500ms native loop across two intervals. Only this
    // isolated fixture waits; the receiver itself never polls.
    await new Promise(r=>setTimeout(r,3100));assert.equal(notices.filter(n=>n.method==='notifications/claude/channel').length,0);
    const secondResponse=await client.callTool({name:'receive',arguments:{message_id:second}});
    // Claude may pass the MCP content array as tool_response and keep metadata
    // separately. Exercise that exact array using the real server's content.
    const contentOnly=f.run(f.event({hook_event_name:'PostToolUse',tool_name:'mcp__plugin_intercom_intercom__receive',tool_input:{message_id:second},tool_response:secondResponse.content}));
    assert.equal(contentOnly.status,0,contentOnly.stderr);assert.equal(f.receipt(second).state,'accepted');
  }));
  await test('default native Claude channel still emits; conflicting second route cannot attach',()=>fixture(async f=>{
    const client=await f.mcp({INTERCOM_CLAUDE_TRANSPORT:''});
    const got=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native channel did not emit')),5000);client.fallbackNotificationHandler=n=>{if(n.method==='notifications/claude/channel'){clearTimeout(timer);resolve(n);}};});
    await client.callTool({name:'join',arguments:{chat:'room',seat:'Receiver'}});
    const duplicate=await f.mcp();await assert.rejects(duplicate.callTool({name:'chats',arguments:{}}),/already has a live/);
    const id=f.send('DEFAULT_CHANNEL_BODY'),notification=await got;
    assert.match(notification.params.content,/DEFAULT_CHANNEL_BODY/);assert.equal(notification.params.meta.id,String(id));
  }));
  await test('untrusted configuration fails closed; revoked lease cannot acknowledge or reserve',()=>fixture(async f=>{
    f.bind();chmodSync(f.file,0o644);assert.equal(f.run(f.event()).status,1);chmodSync(f.file,0o600);
    const id=f.send(),current=route(f.db,f.identity,f.config);atomic(f.db,()=>reserve(f.db,f.identity,current));
    const row=f.db.prepare('SELECT * FROM messages WHERE id=?').get(id),proof={reader_identity:f.identity,message_id:id,...receiveProof(f.db,f.identity,f.connection,f.config,row)};
    f.db.prepare("UPDATE connection_leases SET expires_at=0 WHERE identity=?").run(f.identity);
    const e=f.event({hook_event_name:'PostToolUse',tool_name:'mcp__intercom__receive',tool_input:{message_id:id},tool_response:output(proof)});
    assert.equal(atomic(f.db,()=>acknowledge(f.db,f.identity,current,e)),false);assert.equal(atomic(f.db,()=>reserve(f.db,f.identity,current)),null);assert.equal(f.receipt(id).state,'submitting');
  }));
  await test('disable stops hook without native fallback, receipt retry or cursor advancement',()=>fixture(async f=>{
    f.bind();const waiter=f.wait(f.event());await f.armed();f.config.enabled=false;f.save();
    const result=await waiter.completed;assert.notEqual(result.code,2,result.stderr);
    const id=f.send();assert.equal(f.receipt(id),undefined);assert.equal(getDeliveryCursor(f.db,'room',f.identity,'claude-channel'),0);
  }));
  await test('bounded idle expiry is quiet; delayed SessionEnd cannot revoke resumed route',()=>fixture(async f=>{
    f.bind();const waiter=f.wait(f.event());const result=await waiter.completed;
    assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(result.stdout,'');
    assert.equal(f.run(f.event({hook_event_name:'SessionEnd'})).status,0);assert(route(f.db,f.identity,f.config));
    closeRoute(f.db,f.identity,f.connection);assert.equal(route(f.db,f.identity,f.config),null);
  }));
  await test('enable and native-channel cutover reject unresolved receipts without changing old state',()=>fixture(async f=>{
    f.bind();const id=f.send('pre-cutover');const current=route(f.db,f.identity,f.config);atomic(f.db,()=>reserve(f.db,f.identity,current));
    const before=JSON.stringify({receipt:f.receipt(id),cursor:getDeliveryCursor(f.db,'room',f.identity,'claude-channel')});
    const run=action=>spawnSync(process.execPath,[configurePath,action,'--database',f.database],{env:f.env,encoding:'utf8'});
    assert.equal(run('disable').status,0);assert.equal(run('enable').status,1);
    assert.throws(()=>attachRoute(f.db,f.identity,randomUUID(),null),/Unresolved Claude hook/);
    assert.equal(JSON.stringify({receipt:f.receipt(id),cursor:getDeliveryCursor(f.db,'room',f.identity,'claude-channel')}),before);
  }));
  await test('fresh explicit enable snapshots cutoff without cursor movement or old-message replay',()=>fixture(async f=>{
    f.bind();const id=f.send('pre-cutover');
    const run=action=>spawnSync(process.execPath,[configurePath,action,'--database',f.database],{env:f.env,encoding:'utf8'});
    assert.equal(run('disable').status,0);assert.equal(run('enable').status,0);
    const next=JSON.parse(readFileSync(f.file));assert.equal(next.afterMessageId,id);
    attachRoute(f.db,f.identity,f.connection,next);assert.equal(atomic(f.db,()=>reserve(f.db,f.identity,route(f.db,f.identity,next))),null);
    assert.equal(getDeliveryCursor(f.db,'room',f.identity,'claude-channel'),0);
  }));
  await test('late old-waiter barrier blocks new hook attachment atomically; original route/outcome retained',()=>fixture(async f=>{
    f.bind();
    const original=route(f.db,f.identity,f.config);
    const run=action=>spawnSync(process.execPath,[configurePath,action,'--database',f.database],{env:f.env,encoding:'utf8'});
    assert.equal(run('disable').status,0);assert.equal(run('enable').status,0);
    const next=JSON.parse(readFileSync(f.file));assert.notEqual(next.generation,f.config.generation);
    // Simulate a waiter that read the prior enabled config before disable and
    // wins the reservation after enable's read-only preflight/cutoff snapshot.
    const id=f.send('late old attachment');assert.equal(atomic(f.db,()=>reserve(f.db,f.identity,original)),id);
    const before=JSON.stringify(f.receipt(id));
    assert.throws(()=>attachRoute(f.db,f.identity,randomUUID(),next),/blocks a new hook attachment/);
    assert.deepEqual(route(f.db,f.identity,f.config),original);assert.equal(JSON.stringify(f.receipt(id)),before);
    assert.equal(route(f.db,f.identity,next),null);
    // A harmless same-attachment refresh must not invalidate its own outcome.
    attachRoute(f.db,f.identity,f.connection,f.config);assert.equal(JSON.stringify(f.receipt(id)),before);
  }));
  console.log(`PASS: ${count} Claude hook transport fixtures; no live host contacted`);
}finally{rmSync(root,{recursive:true,force:true});}
