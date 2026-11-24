import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'ic-lr-pipe-'));
Object.assign(process.env,{HOME:root,CODEX_HOME:join(root,'.codex'),CHAT_DB:join(root,'chat.db'),INTERCOM_SERVICE_STATE:join(root,'state'),INTERCOM_SERVICE_SOCKET_DIR:join(root,'socket'),INTERCOM_SERVICE_TEST:'1'});
const fixture=join(root,'closed-stdin.mjs');process.env.INTERCOM_BUNDLE=fixture;
writeFileSync(fixture,`import {closeSync} from 'node:fs';
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'pipe-test',version:'1'}}})+'\\n');setTimeout(()=>closeSync(0),30);}}});setInterval(()=>{},1000);`);
const {Bridge}=await import('../scripts/persistent-common.mjs');
let exits=0,b;try{
 b=new Bridge({persistent:true,onExit:()=>{exits++;b.close();}});
 await b.initialize({});await new Promise(r=>setTimeout(r,150));
 const exit=new Promise(resolve=>b.child.once('exit',resolve));
 const error=await b.request('tools/call',{name:'send'}).catch(e=>e);
 assert(error instanceof Error);assert(b.closed);await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(Error('child left alive')),2000))]);
 b.close();b.close();assert.equal(exits,1);
 console.log('PASS: real stdin EPIPE rejects unknown request and physically retires live child exactly once even after closed state');
}finally{b?.child.kill('SIGTERM');rmSync(root,{recursive:true,force:true});}
