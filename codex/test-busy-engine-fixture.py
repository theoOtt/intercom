#!/usr/bin/env python3
"""Exact Desktop binary, installed real plugin, isolated HOME/DB and loopback mock.
Run under sandbox-exec with external networking denied. Never uses live credentials.
"""
import os,json,time,pathlib,tempfile,subprocess,threading,queue,http.server,re,shutil,sqlite3,uuid,sys
PACKAGE=pathlib.Path(sys.argv[1]);ROOT=pathlib.Path(tempfile.mkdtemp(prefix='iceng-',dir='/tmp'));ROOT.chmod(0o700)
BIN='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
ENV={'HOME':str(ROOT/'home'),'CODEX_HOME':str(ROOT/'codex'),'XDG_CONFIG_HOME':str(ROOT/'xdg'),'INTERCOM_HOME':str(ROOT/'intercom'),'CLAUDE_CONFIG_DIR':str(ROOT/'claude'),'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','TMPDIR':str(ROOT/'tmp'),'LANG':'en_US.UTF-8','CHAT_DB':str(ROOT/'chat.db'),'CHAT_DESKTOP_RELAY':'0','CHAT_AUTOJOIN_PROJECT':'0','INTERCOM_DELIVERY_CONFIG':str(ROOT/'delivery.json')}
for k in ['HOME','CODEX_HOME','XDG_CONFIG_HOME','INTERCOM_HOME','CLAUDE_CONFIG_DIR','TMPDIR']:pathlib.Path(ENV[k]).mkdir()
job=ROOT/'job.py';job.write_text("import signal,sys,time\ndef stop(*args):\n print('INTERCOM_FIXTURE_SIGINT_EXIT_130',flush=True)\n sys.exit(130)\nsignal.signal(signal.SIGINT,stop)\nprint('INTERCOM_FIXTURE_JOB_RUNNING',flush=True)\ntime.sleep(60)\nprint('INTERCOM_FIXTURE_NATURAL_FINISH',flush=True)\n")
requests=[];messages=[];received=set();phase='warmup';phase_calls=0;incoming=queue.Queue();senders=[];session=None
class Rpc:
 def __init__(self,args,env,name):
  self.mcp=name.startswith('sender-');self.log=open(ROOT/(name+'.stderr'),'w');self.p=subprocess.Popen(args,cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,bufsize=1);self.q=queue.Queue();self.seq=0;self.events=[]
  def drain():
   for line in self.p.stdout:
    try:v=json.loads(line);self.events.append(v);self.q.put(v)
    except:pass
  threading.Thread(target=drain,daemon=True).start()
 def call(self,method,params=None,timeout=25):
  self.seq+=1;i=self.seq;v={'id':i,'method':method}
  if self.mcp:v['jsonrpc']='2.0'
  if params is not None:v['params']=params
  self.p.stdin.write(json.dumps(v)+'\n');self.p.stdin.flush();until=time.time()+timeout
  while time.time()<until:
   x=self.q.get(timeout=max(.1,until-time.time()))
   if x.get('id')==i:
    if 'error'in x:raise RuntimeError(x)
    return x['result']
  raise TimeoutError(method)
 def notify(self,method):self.p.stdin.write(json.dumps({'method':method,**({'jsonrpc':'2.0'} if self.mcp else {})})+'\n');self.p.stdin.flush()
 def close(self):
  self.p.stdin.close()
  try:self.p.wait(timeout=5)
  except:self.p.terminate();self.p.wait(timeout=5)
  self.log.close()
def msg(text):return {'type':'response.output_item.done','item':{'id':'msg-'+str(len(requests)),'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}}
def code(text):return {'type':'response.output_item.done','item':{'type':'custom_tool_call','call_id':'call-'+str(len(requests)),'name':'exec','input':text}}
class Mock(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):self.send_response(200);self.end_headers();self.wfile.write(b'{"data":[]}')
 def do_POST(self):
  global phase_calls,session
  body=json.loads(self.rfile.read(int(self.headers.get('content-length',0))));requests.append({'at':time.time(),'phase':phase,'body':body});phase_calls+=1
  if phase=='warmup':item=msg('warmup')
  elif phase_calls==1:item=code('text(await tools.exec_command({cmd:'+json.dumps('exec /opt/homebrew/bin/python3 '+str(job))+',tty:true,yield_time_ms:500,max_output_tokens:1000}));')
  else:
   history=json.dumps(body['input']);match=re.search(r'\\?"session_id\\?"\s*:\s*(\d+)',history)
   if match:session=int(match.group(1))
   notices=[int(x) for x in re.findall(r'receive tool once with message_id=(\d+)',history)];pending=[x for x in notices if x not in received]
   if pending:
    mid=pending[0];received.add(mid);item=code('text(await tools.mcp__intercom__receive({message_id:'+str(mid)+'}));')
   elif len(received)>=3 and session is not None:item=code('text(await tools.write_stdin({session_id:'+str(session)+',chars:"\\u0003",yield_time_ms:1000,max_output_tokens:1000}));') if phase_calls<20 and not any('^C' in json.dumps(x) for x in body['input']) else msg('all fixture peers received and own job stopped')
   elif session is not None and phase_calls<20:item=code('text(await tools.write_stdin({session_id:'+str(session)+',chars:"",yield_time_ms:1000,max_output_tokens:1000}));')
   else:item=msg('fixture failed to receive all messages')
  events=[{'type':'response.created','response':{'id':'resp-'+str(len(requests))}},item,{'type':'response.completed','response':{'id':'resp-'+str(len(requests)),'status':'completed','output':[],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}}]
  data=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode();self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
(ROOT/'codex/config.toml').write_text(f'''model="fixture-model"
model_provider="fixture"
cli_auth_credentials_store="file"
mcp_oauth_credentials_store="file"
check_for_update_on_startup=false
[features]
code_mode=true
code_mode_host=true
[analytics]
enabled=false
[feedback]
enabled=false
[model_providers.fixture]
name="Isolated package fixture"
base_url="http://127.0.0.1:{server.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
''')
market=ROOT/'market';(market/'.agents/plugins').mkdir(parents=True);(market/'plugins').mkdir();shutil.copytree(PACKAGE,market/'plugins/intercom')
# Preserve shipped transport; only isolate descriptor environment side effects.
for descriptor in [market/'plugins/intercom/mcp.json',market/'plugins/intercom/.mcp.json']:
 if not descriptor.exists():continue
 d=json.loads(descriptor.read_text());d['mcpServers']['intercom'].setdefault('env',{}).update({'CHAT_DB':ENV['CHAT_DB'],'CHAT_DESKTOP_RELAY':'0','CHAT_AUTOJOIN_PROJECT':'0'});descriptor.write_text(json.dumps(d))
(market/'.agents/plugins/marketplace.json').write_text(json.dumps({'name':'intercom','plugins':[{'name':'intercom','source':'./plugins/intercom'}]}))
for args in [['plugin','marketplace','add',str(market)],['plugin','add','intercom@intercom']]:
 r=subprocess.run([BIN]+args,cwd=ROOT,env=ENV,capture_output=True,text=True,timeout=25);assert r.returncode==0,(args,r.stderr)
# Initialize only the fixture DB with actual project's chat schema, not a mock DB schema.
source=pathlib.Path(__file__).resolve().parents[1]
prep="import {openDb} from "+json.dumps((source/'bridge/chat-db.mjs').as_uri())+";openDb(process.env.CHAT_DB).close();"
r=subprocess.run(['/opt/homebrew/bin/node','--input-type=module','-e',prep],env=ENV,cwd=ROOT,capture_output=True,text=True);assert r.returncode==0,r.stderr
registry=ROOT/'service-state/registrations.json';registry.parent.mkdir(mode=0o700);registry.write_text('{}');registry.chmod(0o600);state=ROOT/'state';state.mkdir(mode=0o700)
ENV['INTERCOM_SERVICE_STATE']=str(registry.parent);ENV['INTERCOM_SERVICE_SOCKET_DIR']=str(ROOT/'service-socket');ENV['INTERCOM_SERVICE_TEST']='1';(ROOT/'service-socket').mkdir(mode=0o700)
delivery={'enabled':True,'version':1,'mode':'enrolled-desktop','busyHooks':True,'idleQueue':False,'database':ENV['CHAT_DB'],'registry':str(registry),'stateDir':str(state),'afterMessageId':0,'generation':str(uuid.uuid4()),'waitTimeoutMs':60000}
(ROOT/'delivery.json').write_text(json.dumps(delivery));(ROOT/'delivery.json').chmod(0o600)
normal_config=ROOT/'home/.config/intercom/desktop-delivery.json';normal_config.parent.mkdir(parents=True);normal_config.write_text(json.dumps(delivery));normal_config.chmod(0o600)
engine=Rpc([BIN,'app-server','--stdio'],ENV,'engine');started=time.time()
try:
 engine.call('initialize',{'clientInfo':{'name':'isolated-packaged-busy-fixture','version':'1'},'capabilities':{'experimentalApi':True}});engine.notify('initialized')
 tid=engine.call('thread/start',{'model':'fixture-model','modelProvider':'fixture','cwd':str(ROOT),'approvalPolicy':'never','sandbox':'danger-full-access','persistExtendedHistory':True})['thread']['id']
 registry.write_text(json.dumps({tid:{'source':'executor-tool-metadata','registeredAt':int(time.time()*1000)}}));registry.chmod(0o600)
 status=engine.call('mcpServerStatus/list',{'threadId':tid,'detail':'full'});(ROOT/'mcp-status.json').write_text(json.dumps(status,indent=2))
 tool=lambda name,args:engine.call('mcpServer/tool/call',{'threadId':tid,'server':'intercom','tool':name,'arguments':args})
 tool('join',{'chat':'fixture-alpha','seat':'ActualReceiver'});tool('join',{'chat':'fixture-beta','seat':'ActualReceiver'})
 hooks=engine.call('hooks/list',{'threadId':tid});entries=[h for row in hooks['data'] for h in row['hooks'] if h.get('pluginId','').startswith('intercom')];(ROOT/'hooks-untrusted.json').write_text(json.dumps(hooks,indent=2));assert len(entries)>=7,hooks
 engine.call('config/batchWrite',{'edits':[{'keyPath':'hooks.state','value':{e['key']:{'trusted_hash':e['currentHash']} for e in entries},'mergeStrategy':'upsert'}],'reloadUserConfig':True})
 trusted=engine.call('hooks/list',{'threadId':tid});(ROOT/'hooks-trusted.json').write_text(json.dumps(trusted,indent=2));assert all(h['trustStatus']=='trusted' for row in trusted['data'] for h in row['hooks'] if h.get('pluginId','').startswith('intercom')),trusted
 print('PASS actual installed package hooks discovered/trusted via normal isolated owning-engine API',ROOT,tid,flush=True)
 for ns,room in [('claude','fixture-alpha'),('codex','fixture-beta'),('copilot','fixture-alpha')]:
  se=dict(ENV,CHAT_IDENTITY=ns+':'+str(uuid.uuid4()),CHAT_AUTOJOIN_PROJECT='0');actor=Rpc(['/opt/homebrew/bin/node',str(PACKAGE/'dist/bridge.mjs')],se,'sender-'+ns);senders.append((actor,ns,room));actor.call('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'fixture-peer','version':'1'}});actor.notify('notifications/initialized');actor.call('tools/call',{'name':'join','arguments':{'chat':room,'seat':'Fixture-'+ns}})
 def produce():
  time.sleep(1)
  for actor,ns,room in senders:
   result=actor.call('tools/call',{'name':'send','arguments':{'chat':room,**({} if ns=='codex' else {'to':'ActualReceiver'}),'body':'ISOLATED_REAL_PEER_'+ns}});(ROOT/('send-'+ns+'.json')).write_text(json.dumps(result,indent=2));time.sleep(.3)
 phase='busy';phase_calls=0;before=len([x for x in engine.events if x.get('method')=='turn/completed']);threading.Thread(target=produce,daemon=True).start();t=time.time();engine.call('turn/start',{'threadId':tid,'input':[{'type':'text','text':'Run the fixture job and handle incoming fixture peers.'}]})
 while time.time()-t<35 and len([x for x in engine.events if x.get('method')=='turn/completed'])==before:time.sleep(.1)
 elapsed=time.time()-t
 with sqlite3.connect(ENV['CHAT_DB']) as db:
  receipts=db.execute('SELECT identity,message_id,state,detail FROM delivery_receipts ORDER BY message_id').fetchall();cursors=db.execute("SELECT chat,last_read_id FROM delivery_cursors WHERE identity=? AND consumer='codex-app-server' ORDER BY chat",('codex:'+tid,)).fetchall();busy=db.execute('SELECT * FROM intercom_busy_turns').fetchall();count=db.execute('SELECT count(*) FROM messages').fetchone()[0];physical=db.execute('SELECT id,chat,sender_identity,to_identity,body FROM messages ORDER BY id').fetchall()
 summary={'root':str(ROOT),'threadId':tid,'elapsed':elapsed,'receivedIds':sorted(received),'receipts':receipts,'cursors':cursors,'busyMarkersAfterStop':busy,'messageCount':count,'physicalMessages':physical,'requests':len(requests),'turnIds':sorted(set((x['body'].get('client_metadata')or{}).get('turn_id','') for x in requests))};(ROOT/'summary.json').write_text(json.dumps(summary,indent=2));print('RESULT',json.dumps(summary),flush=True)
 actual_inputs=json.dumps([r['body']['input'] for r in requests])
 assert all('ISOLATED_REAL_PEER_'+ns in actual_inputs for ns in ['claude','codex','copilot']),'Original peer token not observed through real receive output'
 assert len(physical)==3 and {row[2].split(':')[0] for row in physical}=={'claude','codex','copilot'} and all(row[3]==('codex:'+tid if not row[2].startswith('codex:') else None) for row in physical),'Actual bridge sender rows mismatch'
 assert len(received)==3 and len(receipts)==3 and all(r[2]=='accepted' for r in receipts),summary
 assert elapsed<30 and len(summary['turnIds'])==1 and not busy,summary
 developers=json.dumps([i for r in requests for i in r['body']['input'] if i.get('role')=='developer']);assert 'ISOLATED_REAL_PEER_' not in developers,'Peer body promoted to developer context'
 stop_outputs=[item.get('output',[]) for r in requests for item in r['body']['input'] if item.get('type')=='custom_tool_call_output' and '^C' in json.dumps(item)]
 assert stop_outputs and 'exit_code' in json.dumps(stop_outputs),'Own job exit after interrupt not observed'
 assert 'INTERCOM_FIXTURE_SIGINT_EXIT_130' in actual_inputs and 'INTERCOM_FIXTURE_NATURAL_FINISH' not in actual_inputs,'Explicit SIGINT early-exit proof missing'
 print('PASS real package + actual arbitrary Claude/Codex/Copilot sends + two rooms + same-turn receive ACK + no duplicate + early job stop',flush=True)
finally:
 (ROOT/'requests.json').write_text(json.dumps(requests,indent=2));(ROOT/'messages.json').write_text(json.dumps(engine.events,indent=2))
 for actor,_,_ in senders:actor.close()
 engine.close();server.shutdown();(ROOT/'cleanup.json').write_text(json.dumps({'engineExit':engine.p.returncode,'senderExits':{ns:actor.p.returncode for actor,ns,_ in senders},'stderr':{f.name:f.read_text() for f in ROOT.glob('*.stderr')}},indent=2));print('CLEANUP exact fixture engine exit',engine.p.returncode,'evidence',ROOT,flush=True)
