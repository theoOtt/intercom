import {createConnection} from 'node:net';
import {lstatSync} from 'node:fs';
import {Bridge,VERSION,SOCKET,SOCKET_DIR,threadId,lines,bundleFingerprint} from './persistent-common.mjs';
const output=m=>process.stdout.write(JSON.stringify(m)+'\n');
let initialized=false,persistent=false,clientInfo,local,bound=null,binding=null,socket,sequence=0,pending=new Map();
local=new Bridge({onEvent:output});
async function connectOnce(){
 if(socket&&!socket.destroyed)return;
 const dir=lstatSync(SOCKET_DIR),file=lstatSync(SOCKET);
 if(dir.uid!==process.getuid()||(dir.mode&0o077)||!dir.isDirectory()||file.uid!==process.getuid()||!file.isSocket())throw Error('Unsafe Intercom service socket');
 const s=socket=createConnection(SOCKET);
 lines(s,m=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.result)});
 const failed=()=>{if(socket!==s)return;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Intercom service connection closed; any in-flight operation outcome is unknown and was not retried'))}pending.clear();binding=null;};
 s.on('error',failed);s.on('close',failed);
 await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('error',reject)});
 const hello=await rpc('hello',{});if(hello.version!==VERSION||hello.bundle!==bundleFingerprint())throw Error('Intercom service runtime differs from the plugin; a supervised service update is required');
}
async function connect(){
 const deadline=Date.now()+10000;
 while(true){
  try{return await connectOnce()}
  catch(error){
   socket?.destroy();socket=null;
   if(!['ENOENT','ECONNREFUSED','ECONNRESET'].includes(error.code)||Date.now()>=deadline)throw error;
   await new Promise(resolve=>setTimeout(resolve,200));
  }
 }
}
function rpc(op,data){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Intercom service request timed out; outcome unknown; not retried'))},40000);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({id,op,...data})+'\n');});}
lines(process.stdin,async m=>{
 if(!m.method){local?.response(m);return;}
 try{
  if(m.method==='initialize'){
   clientInfo=m.params.clientInfo;persistent=/codex/i.test(clientInfo?.name||'')&&!process.env.CHAT_IDENTITY_FILE&&process.env.CHAT_DESKTOP_RELAY!=='0';
   const result=await local.request('initialize',m.params);output({jsonrpc:'2.0',id:m.id,result});return;
  }
  if(m.method==='notifications/initialized'){initialized=true;local?.notify(m.method,m.params);return;}
  if(m.method==='tools/call'&&persistent){
   if(!initialized)throw Error('MCP initialization required');
   const task=threadId(m.params?._meta);if(bound&&bound!==task)throw Error('Different task metadata on an existing Intercom frontend');bound=task;
   if(!binding)binding=(async()=>{await connect();await rpc('bind',{meta:m.params._meta});local?.close();local=null;})().catch(e=>{binding=null;throw e});
   await binding;const result=await rpc('call',{params:m.params});output({jsonrpc:'2.0',id:m.id,result});return;
  }
  if(!local)local=new Bridge({onEvent:output});
  // tools/list remains usable before binding; it never guesses a task identity.
  if(m.method==='tools/list'&&local.seq===0)await local.initialize({protocolVersion:'2025-06-18',capabilities:{},clientInfo});
  if('id'in m){const result=await local.request(m.method,m.params);output({jsonrpc:'2.0',id:m.id,result});}else local.notify(m.method,m.params);
 }catch(e){if('id'in m)output({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}});else process.stderr.write(e.message+'\n');}
});
process.stdin.on('end',()=>{local?.close();socket?.end();setTimeout(()=>process.exit(0),100).unref();});
