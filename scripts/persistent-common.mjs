import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,lstatSync,readFileSync,statSync} from 'node:fs';
export const VERSION=1;
export const NODE=process.env.INTERCOM_NODE || process.execPath;
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const BUNDLE=process.env.INTERCOM_BUNDLE || join(ROOT,'dist/bridge.mjs');
export const bundleFingerprint=()=>createHash('sha256').update(readFileSync(BUNDLE)).digest('hex');
export const DB=resolve(process.env.CHAT_DB || join(homedir(),'.claude/intercom/chat.db'));
const key=createHash('sha256').update(DB).digest('hex').slice(0,12);
export const STATE=process.env.INTERCOM_SERVICE_STATE || join(homedir(),'.local/share/intercom/desktop-service',key);
export const SOCKET_DIR=process.env.INTERCOM_SERVICE_SOCKET_DIR || `/private/tmp/intercom-desktop-${process.getuid()}-${key}`;
export const SOCKET=join(SOCKET_DIR,'service.sock');
export function secureDirectory(p){
 mkdirSync(p,{recursive:true,mode:0o700});const s=lstatSync(p);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error(`Unsafe Intercom service directory: ${p}`);
}
export function threadId(meta){
 if(!meta||typeof meta!=='object')throw Error('Missing executor task metadata');
 let turn=meta['x-codex-turn-metadata'];if(typeof turn==='string')turn=JSON.parse(turn);
 const ids=['openai/threadId','openai/thread_id','codexThreadId','codex_thread_id','threadId','thread_id'].map(k=>meta[k]);ids.push(turn?.thread_id,meta.thread?.id);
 const values=ids.filter(v=>v!==null&&v!==undefined);
 if(!values.length||values.some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v))||new Set(values).size!==1)throw Error('Missing, conflicting, or invalid executor task metadata');
 return values[0];
}
export function lines(stream,fn){let buffer='';stream.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024){stream.destroy();return}let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(line.trim())try{fn(JSON.parse(line))}catch(e){process.stderr.write(`[intercom] protocol error: ${e.message}\n`)}}});}
export class Bridge {
 constructor({persistent=false,onEvent=()=>{},onExit=()=>{}}={}){
  this.seq=0;this.pending=new Map();this.closed=false;
  const env={...process.env,CHAT_DB:DB};
  if(persistent){for(const k of ['CHAT_IDENTITY','CHAT_IDENTITY_FILE','CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CHAT','CHAT_PROJECT','SEAT'])delete env[k];Object.assign(env,{CHAT_AUTOJOIN_PROJECT:'0',CHAT_PROJECT_FROM_ROOTS:'0',CHAT_DESKTOP_RELAY:'1',CHAT_SERVICE_WORKER:'1'});}
  this.child=spawn(NODE,[fileURLToPath(new URL('./persistent-worker-entry.mjs',import.meta.url))],{env,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',b=>process.stderr.write(b));
  lines(this.child.stdout,m=>{if(m.method==='notifications/intercom/worker-terminal'&&m.params?.code==='attachment-terminal'){this.retire(Object.assign(Error(`Intercom worker terminal: ${m.params.message}; in-flight operation outcome unknown; not retried`),{code:'INTERCOM_WORKER_TERMINAL'}));return;}const p=this.pending.get(m.id);if(p&&('result'in m||'error'in m)){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else onEvent(m)});
  const fail=e=>{if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e)}this.pending.clear();onExit(e)};
  this.retiring=false;
  this.retire=e=>{fail(e);if(this.retiring)return;this.retiring=true;this.child.stdin.end();this.child.kill('SIGTERM');};
  this.child.stdin.on('error',e=>this.retire(e));
  this.child.on('error',fail);this.child.on('exit',()=>fail(Error('Intercom worker exited; in-flight operation outcome unknown; not retried')));
 }
 request(method,params={},timeout=30000){
  if(this.closed)return Promise.reject(Error('Intercom worker unavailable'));
  const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Intercom worker request timed out; outcome unknown; not retried'))},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 }
 notify(method,params){if(!this.closed)this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,...(params?{params}:{})})+'\n');}
 response(message){if(!this.closed)this.child.stdin.write(JSON.stringify(message)+'\n');}
 async initialize(params){const r=await this.request('initialize',params);this.notify('notifications/initialized');return r;}
 close(){this.retire(Error('Intercom worker retired; in-flight operation outcome unknown; not retried'));}
}
let configStamp=null,lastEnabled=false,nextConfigRetry=0;
export function enabled(){
 if(process.env.INTERCOM_SERVICE_TEST==='1')return true;
 if(Date.now()<nextConfigRetry)return lastEnabled;
 const path=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'config.toml');
 try{
  const stat=statSync(path),stamp=`${stat.mtimeMs}:${stat.size}`;
  if(stamp===configStamp)return lastEnabled;
  const code='import json,sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); print(json.dumps(d.get("plugins",{}).get("intercom@intercom",{}).get("enabled",False) is True))';
  lastEnabled=JSON.parse(execFileSync(process.env.INTERCOM_CONFIG_PYTHON||'/opt/homebrew/bin/python3',['-c',code,path],{encoding:'utf8',timeout:2000}));
  configStamp=stamp;nextConfigRetry=0;return lastEnabled;
 }catch(error){
  if(error.code==='ENOENT'){lastEnabled=false;configStamp=null;}
  nextConfigRetry=Date.now()+5000;
  process.stderr.write(`[intercom-service] configuration read deferred: ${error.message}\n`);
  return lastEnabled;
 }
}
