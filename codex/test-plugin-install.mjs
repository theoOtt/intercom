// Exercise actual marketplace installation and MCP discovery. Do not override
// the launch command, arguments, cwd, or PLUGIN_ROOT: that hid the 0.5.2 bug.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {AppServerClient} from './app-server-client.mjs'
import {DatabaseSync} from 'node:sqlite'
import {openDb} from '../bridge/chat-db.mjs'
const temp=mkdtempSync(join(process.cwd(),'.intercom-plugin-install-'))
const home=join(temp,'codex-home'),market=join(temp,'marketplace with spaces'),project=join(temp,'project-check')
const source=resolve(JSON.parse(readFileSync('.agents/plugins/marketplace.json','utf8')).plugins.find(p=>p.name==='intercom').source.path),fixture=join(market,'plugins/intercom')
const codexBinary=process.env.INTERCOM_TEST_CODEX || 'codex';
let server,client,serverErrors=''
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const env={...process.env,HOME:join(temp,'os-home'),INTERCOM_HOME:join(temp,'os-home'),CHAT_DB:join(temp,'chat.db'),INTERCOM_DELIVERY_CONFIG:join(temp,'os-home/.config/intercom/desktop-delivery.json'),CODEX_HOME:home,RUST_LOG:'warn,codex_rmcp_client=info'}
for(const key of ['CHAT_IDENTITY_FILE','CHAT_IDENTITY','CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID'])delete env[key]
function cli(args){const r=spawnSync(codexBinary,args,{env,cwd:project,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout}
try{
 mkdirSync(env.HOME,{recursive:true});mkdirSync(home,{recursive:true});mkdirSync(project,{recursive:true})
 writeFileSync(join(home,'config.toml'),`model = "fixture-model"
model_provider = "fixture"
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
check_for_update_on_startup = false
[analytics]
enabled = false
[feedback]
enabled = false
[model_providers.fixture]
name = "Loopback fixture only"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
`)

 console.log('Fixture Codex executable:',codexBinary,cli(['--version']).trim());
 // Normal setup prepares the shared DB before sessions start.
 const prepared=openDb(join(temp,'chat.db'));prepared.close()
 mkdirSync(join(market,'.agents/plugins'),{recursive:true});cpSync(source,fixture,{recursive:true})
 const descriptorFile='.mcp.json'
 const descriptor=JSON.parse(readFileSync(join(fixture,descriptorFile),'utf8'))
 const original=structuredClone(descriptor.mcpServers.intercom)
 // Isolate database side effects only; preserve the shipped transport verbatim.
 Object.assign(descriptor.mcpServers.intercom.env,{CHAT_DB:join(temp,'chat.db'),CHAT_DESKTOP_RELAY:'0'})
 writeFileSync(join(fixture,descriptorFile),JSON.stringify(descriptor,null,2))
 const fixtureMarket=JSON.parse(readFileSync('.agents/plugins/marketplace.json','utf8'));fixtureMarket.plugins.find(p=>p.name==='intercom').source.path='./plugins/intercom';writeFileSync(join(market,'.agents/plugins/marketplace.json'),JSON.stringify(fixtureMarket))
 cli(['plugin','marketplace','add',market]);cli(['plugin','add','intercom@intercom'])
 const configured=JSON.parse(cli(['mcp','get','intercom','--json']))
 console.log('Installed transport:',JSON.stringify(configured.transport))
 assert(!readFileSync(join(home,'config.toml'),'utf8').includes('[mcp_servers.intercom]'),'test must use plugin discovery, not manual MCP config')
 const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
 server=spawn(codexBinary,['app-server','--listen',`ws://127.0.0.1:${port}`],{env,cwd:project,detached:true,stdio:['ignore','ignore','pipe']})
 let errors='';server.stderr.on('data',b=>{errors+=b;serverErrors+=b})
 const deadline=Date.now()+20_000
 while(true){try{if((await fetch(`http://127.0.0.1:${port}/readyz`)).ok)break}catch{}
  if(Date.now()>deadline)throw Error(`Server not ready: ${errors}`);await sleep(100)}
 client=new AppServerClient(`ws://127.0.0.1:${port}`)
 await client.connect()
 const {thread}=await client.request('thread/start',{cwd:project})
 await sleep(750) // Let one-time bundled-plugin configuration settle.
 const events=[];client.on('mcpServer/startupStatus/updated',e=>events.push(e))
 let intercom
 for(let i=0;i<150;i++){
  const status=await client.request('mcpServerStatus/list',{threadId:thread.id,detail:'full'})
  intercom=status.data.find(s=>s.name==='intercom')
  if(Object.keys(intercom?.tools||{}).length===10)break
  if(intercom?.runtimeStatus==='failed')throw Error(`Plugin MCP startup failed: ${JSON.stringify(events.filter(e=>e.name==='intercom'))}`)
  await sleep(200)
 }
 assert(intercom,'Installed plugin absent from MCP inventory')
 assert.deepEqual(Object.keys(intercom.tools||{}).sort(),['chats','delivery','history','join','leave','listen','receive','rename','send','who'])
 const hookState=await client.request('hooks/list',{cwds:[project]});
 const pluginHooks=hookState.data.flatMap(entry=>entry.hooks).filter(hook=>hook.sourcePath?.includes('codex-hooks'));
 if(!pluginHooks.length)console.error('Fixture hook inventory:',JSON.stringify(hookState));
 assert(pluginHooks.length>=7,'Installed Intercom hook declarations were not loaded');
 assert.deepEqual([...new Set(pluginHooks.map(hook=>hook.eventName))].sort(),['interrupt','postToolUse','preToolUse','sessionEnd','stop','userPromptSubmit'].sort());
 assert(pluginHooks.every(hook=>hook.sourcePath.includes('codex-hooks')),'Hooks must come from this installed plugin');
 console.log('PASS: actual isolated plugin loader discovers all Codex lifecycle hook declarations; trust admission left unchanged');
 const result=await client.request('mcpServer/tool/call',{threadId:thread.id,server:'intercom',tool:'chats',arguments:{}})
 const text=result.content.map(i=>i.text||'').join('\n')
 assert.match(text,new RegExp(`Identity: codex:${thread.id}`))
 assert(text.includes('project-check (seat') || text.includes('Project autojoin unavailable'),text)
 assert(!text.includes('You are in: 0.'),'never autojoin the plugin version directory')
 const joined=await client.request('mcpServer/tool/call',{threadId:thread.id,server:'intercom',tool:'join',arguments:{chat:'package-test',seat:'Installed'}})
 assert(joined.content.some(i=>i.text?.includes('Installed')))
 const shipped=JSON.parse(readFileSync(join(fixture,descriptorFile),'utf8')).mcpServers.intercom
 for(const field of ['command','args','cwd'])assert.deepEqual(shipped[field],original[field])
 console.log('PASS: marketplace-installed plugin launches without path overrides, exposes ten tools, executes chats/join, and does not confuse plugin cwd with project cwd')
}catch(error){
 console.error(serverErrors.slice(-6000))
 try {const logs=new DatabaseSync(join(home,'logs_2.sqlite'),{readOnly:true});console.error(logs.prepare("SELECT feedback_log_body FROM logs WHERE target LIKE '%stdio_server_launcher%' ORDER BY id DESC LIMIT 25").all());logs.close()}catch{}
 throw error
}finally{
 client?.close()
 if(server){try{process.kill(-server.pid,'SIGTERM')}catch{};await sleep(700);if(server.exitCode===null&&server.signalCode===null){try{process.kill(-server.pid,'SIGKILL')}catch{}}}
 rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
