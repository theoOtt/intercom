import {desktopQueueStatus} from './desktop-queue.mjs';
import {execFileSync} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {readFileSync,writeFileSync,renameSync,existsSync,unlinkSync,chmodSync,lstatSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DesktopIpc} from './desktop-owner.mjs';
import {Bridge,VERSION,DB,STATE,SOCKET_DIR,SOCKET,secureDirectory,threadId,lines,enabled,bundleFingerprint} from './persistent-common.mjs';
secureDirectory(STATE);secureDirectory(SOCKET_DIR);
const BUILD=bundleFingerprint();
const registryPath=join(STATE,'registrations.json'),pidPath=join(SOCKET_DIR,'owner.json');
let registry=existsSync(registryPath)?JSON.parse(readFileSync(registryPath,'utf8')):{};
if(!registry||Array.isArray(registry)||typeof registry!=='object')throw Error('Invalid service registry');
for(const id of Object.keys(registry))if(threadId({threadId:id})!==id||registry[id]?.source!=='executor-tool-metadata')throw Error('Invalid registered task');
const workers=new Map(),frontends=new Map(),retryAt=new Map(),failures=new Map();let stopping=false,dirty=false;let db;
const inspect=()=>{if(!db&&existsSync(DB))db=new DatabaseSync(DB,{readOnly:true});return db;};
const subscribed=id=>{try{return !!inspect()?.prepare('SELECT 1 FROM subscriptions WHERE identity=? LIMIT 1').get('codex:'+id)}catch{return null;}};
const save=()=>{dirty=true;const tmp=registryPath+'.tmp';const fd=openSync(tmp,'w',0o600);try{writeSync(fd,JSON.stringify(registry,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,registryPath);const dir=openSync(STATE,'r');try{fsyncSync(dir)}finally{closeSync(dir)}dirty=false;};
function liveLegacy(id){try{return !!inspect()?.prepare("SELECT 1 FROM connection_leases WHERE identity=? AND role='bridge' AND expires_at>?").get('codex:'+id,Date.now())}catch{return true;}}
function deferWorker(id){
 const count=(failures.get(id)||0)+1;failures.set(id,count);
 retryAt.set(id,Date.now()+Math.min(30000,1000*2**Math.min(count-1,5)));
}
function retireWorker(id,entry){
 if(workers.get(id)!==entry)return;
 workers.delete(id);entry.retired=true;deferWorker(id);entry.bridge?.close();
}
function active(id,entry){
 if(workers.get(id)!==entry||entry.retired||entry.bridge.closed)
  throw Error('Intercom worker retired; in-flight operation outcome unknown; not retried');
}
function markHealthy(id,entry){
 active(id,entry);entry.bound=true;entry.healthySince??=Date.now();
 // A brief successful rebind is not stability: retain exponential history.
 if(Date.now()-entry.healthySince>=30000){retryAt.delete(id);failures.delete(id);}
}
async function worker(id){
 if(!enabled())throw Error('Intercom plugin is disabled; persistent delivery is paused');
 const cached=workers.get(id);if(cached){active(id,cached);return cached;}
 if(Date.now()<(retryAt.get(id)||0))throw Error('Intercom worker recovery backoff; retry a new operation later; previous operation was not retried');
 if(liveLegacy(id)){deferWorker(id);throw Error('An existing Intercom bridge is still live; it will not be interrupted or replaced');}
 const entry={bridge:null,ready:null};workers.set(id,entry);
 const bridge=entry.bridge=new Bridge({persistent:true,onExit:()=>retireWorker(id,entry)});
 entry.ready=bridge.initialize({protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-intercom-desktop-service',version:String(VERSION)}});
 try{await entry.ready;active(id,entry);return entry}catch(e){retireWorker(id,entry);throw e;}
}
async function bootstrap(id){
 const entry=await worker(id);await entry.ready;active(id,entry);
 if(entry.bound){markHealthy(id,entry);return;}
 if(!entry.binding)entry.binding=entry.bridge.request('tools/call',{name:'chats',arguments:{},_meta:{threadId:id}}).then(r=>{active(id,entry);if(r.isError)throw Error(JSON.stringify(r));markHealthy(id,entry);return r}).catch(e=>{entry.binding=null;retireWorker(id,entry);throw e});
 return entry.binding;
}
const allowed=new Set(['chats','join','leave','send','history','who','rename','delivery','receive','listen']);
const ownerChecks=new Map();
async function desktopStatus(id) {
 if(ownerChecks.has(id))return ownerChecks.get(id);
 const check=(async()=>{
  const client=new DesktopIpc();
  try{return {state:'ready',threadId:id,owner:await client.findOwner(id)}}
  catch(error){
   if(error.intercomLegacySocketRefused===true){const queue=desktopQueueStatus(id);if(queue.state==='enrolled_queue_configured')return {...queue,legacyError:error.message};}
   return {state:error.message==='no-client-found'?'activation_required':'unavailable',threadId:id,error:error.message};
  }
  finally{client.close()}
 })();
 ownerChecks.set(id,check);
 try{return await check}finally{ownerChecks.delete(id)}
}
const server=createServer(socket=>{
 let bound=null;
 const send=m=>{if(!socket.destroyed)socket.write(JSON.stringify(m)+'\n')};
 lines(socket,async message=>{
  const id=message.id;
  try{
   if(message.op==='hello'){send({id,result:{version:VERSION,pid:process.pid,bundle:BUILD}});return;}
   if(message.op==='bind'){
    const task=threadId(message.meta);
    if(bound&&bound!==task)throw Error('Different executor identity on an existing frontend');
    const previous=frontends.get(task);if(previous&&previous!==socket&&!previous.destroyed)throw Error('Task already has a live Intercom frontend; no connection was replaced');
    bound=task;frontends.set(task,socket);send({id,result:{threadId:task}});return;
   }
   if(message.op!=='call'||!bound)throw Error('Frontend must bind actual executor metadata first');
   const params=message.params;
   if(threadId(params?._meta)!==bound)throw Error('Executor task metadata changed; refusing cross-session access');
   if(!allowed.has(params.name))throw Error('Unsupported Intercom operation');
   const entry=await worker(bound);await entry.ready;active(bound,entry);
   const result=await entry.bridge.request('tools/call',params);
   active(bound,entry);
   if(!result.isError){
    markHealthy(bound,entry);
    const hasRooms=subscribed(bound);
    if(hasRooms===true&&!registry[bound]){registry[bound]={registeredAt:Date.now(),source:'executor-tool-metadata'};save();}
    if(hasRooms===false&&registry[bound]){delete registry[bound];save();}
    if((params.name==='chats'||params.name==='join')&&hasRooms===true){
     const status=await desktopStatus(bound);
     result._meta={...result._meta,intercomDesktop:status};
     const text=status.state==='ready'
      ? 'Connection: persistent Intercom service. Desktop owner verified; the delivery route is available. This check does not prove receipt of a new message.'
      : status.state==='enrolled_queue_configured'
      ? 'Connection: persistent Intercom service. Durable queue delivery is configured for this enrolled Desktop chat. Its current loaded state is unknown. Active turns may defer queue dispatch; unloaded or interrupted chats may wait. Enqueue acceptance is not proof of dispatch or reading. Peer text stays in Intercom; notifications request one exact receive lookup.'
      : status.state==='activation_required'
      ? `Connection: persistent Intercom service. Desktop activation required for this chat (${bound}); room membership alone does not enable notifications. To complete the user's join/reconnect request, use the normal Codex navigate_to_codex_page tool with threadId="${bound}", then call chats() once to verify the owner. Do this for your own executor chat only; do not send a message, open another runtime, or report notifications ready before verification. If the native tool is unavailable, report the activation requirement.`
      : `Connection: persistent Intercom service. Desktop route unavailable: ${status.error}. Do not claim notifications are ready or resend pending messages.`;
     result.content?.push({type:'text',text});
    }
   }
   send({id,result});
  }catch(e){send({id,error:e.message});}
 });
 socket.on('error',()=>{});
 socket.on('close',()=>{if(bound&&frontends.get(bound)===socket){frontends.delete(bound);if(!registry[bound]){workers.get(bound)?.bridge.close();workers.delete(bound);}}});
});
// Never unlink a live service's socket or replace an existing process.
if(existsSync(SOCKET)){
 const s=lstatSync(SOCKET);if(!s.isSocket()||s.uid!==process.getuid())throw Error('Unsafe Intercom socket');
 let owner;try{owner=JSON.parse(readFileSync(pidPath,'utf8'))}catch{}
 if(owner?.pid){try{const started=execFileSync('/bin/ps',['-p',String(owner.pid),'-o','lstart='],{encoding:'utf8'}).trim();if(started===owner.started)process.exit(0)}catch(e){if(e.status!==1)throw e;}}
 else throw Error('Socket owner is unknown; refusing to replace it');
 unlinkSync(SOCKET);
}
server.listen(SOCKET,()=>{chmodSync(SOCKET,0o600);writeFileSync(pidPath,JSON.stringify({pid:process.pid,version:VERSION,started:execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim()})+'\n',{mode:0o600});process.stderr.write('[intercom-service] ready\n');});
server.on('error',e=>{process.stderr.write(e.message+'\n');process.exit(1);});
let sweeping=false;
const timer=setInterval(async()=>{
 if(stopping||sweeping)return;sweeping=true;
 try{
  if(dirty)try{save()}catch(e){process.stderr.write(`[intercom-service] registry persistence deferred: ${e.message}\n`)}
  if(!enabled()){
   for(const w of workers.values())w.bridge.close();workers.clear();retryAt.clear();failures.clear();return;
  }
  for(const id of Object.keys(registry)){
   if(Date.now()<(retryAt.get(id)||0))continue;
   const hasRooms=subscribed(id);
   if(hasRooms===false){delete registry[id];save();if(!frontends.has(id)){workers.get(id)?.bridge.close();workers.delete(id);}continue;}
   try{await bootstrap(id)}catch(e){if(Date.now()>=(retryAt.get(id)||0))deferWorker(id);if(registry[id]&&Date.now()-(registry[id].lastLog||0)>30000){process.stderr.write(`[intercom-service] ${id}: ${e.message}\n`);registry[id].lastLog=Date.now();}}
  }
 }finally{sweeping=false;}
},1500);
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);server.close();for(const s of frontends.values())s.destroy();for(const w of workers.values())w.bridge.close();setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
