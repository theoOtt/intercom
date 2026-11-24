import {mkdtempSync,cpSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'intercom-source-fixtures-')),fixture=join(temp,'source');
const home=join(temp,'home');mkdirSync(home,{recursive:true});
const fixtureEnv={PATH:process.env.PATH,INTERCOM_TEST_CODEX:process.env.INTERCOM_TEST_CODEX,NODE_PATH:process.env.NODE_PATH,HOME:home,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),INTERCOM_TEST_SDK:process.env.INTERCOM_TEST_SDK,INTERCOM_TEST_EXTENSION_SDK:process.env.INTERCOM_TEST_EXTENSION_SDK};
const run=(file,args=[],extra={})=>{const result=spawnSync(process.execPath,[file,...args],{cwd:fixture,env:{...fixtureEnv,...extra},encoding:'utf8',timeout:120000});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.status!==0)throw Error(file+' failed ('+result.status+')');};
try{
 cpSync(root,fixture,{recursive:true,filter:p=>!['.git','node_modules'].includes(basename(p))&&!basename(p).startsWith('.intercom-plugin-install-')});
 symlinkSync(join(root,'bridge/node_modules'),join(fixture,'bridge/node_modules'),'dir');
 run('bridge/build-plugin.mjs');
 for(const file of ['bridge/test-db.mjs','bridge/test-visibility.mjs','bridge/test-sqlite-recovery.mjs','bridge/test-worker-retirement.mjs','bridge/test-native-handoff.mjs','bridge/test-sessions.mjs','bridge/test-mcp.mjs','bridge/test-copilot-relay.mjs','bridge/test-lifecycle.mjs','bridge/test-codex-metadata.mjs','bridge/test-claude-hooks.mjs','codex/test-desktop-relay.mjs','codex/test-desktop-ipc-transport.mjs','codex/test-general-delivery.mjs','plugins/intercom/test-setup.mjs','codex/test-plugin-install.mjs'])run(file);
 run('bridge/test-claude-hooks.mjs',[],{INTERCOM_BRIDGE_PATH:join(fixture,'plugins/intercom/dist/bridge.mjs'),INTERCOM_CLAUDE_HOOK_PATH:join(fixture,'plugins/intercom/runtime/claude/hook.mjs'),INTERCOM_CLAUDE_CONFIGURE_PATH:join(fixture,'plugins/intercom/runtime/claude/configure.mjs')});
 const build=join(temp,'copilot-build');run('bridge/build-copilot.mjs',[build]);
 if(process.env.INTERCOM_TEST_SDK){
  run('bridge/test-copilot-mcp.cjs',[],{INTERCOM_TEST_BUILD:build});
  if(process.env.INTERCOM_TEST_EXTENSION_SDK)run('bridge/test-copilot-sdk.cjs',[],{INTERCOM_TEST_BUILD:build});
  else console.log('SKIP: native Copilot extension SDK fixture (INTERCOM_TEST_EXTENSION_SDK absent)');
 }else console.log('SKIP: host Copilot SDK fixtures (INTERCOM_TEST_SDK absent); source MCP and relay fixtures executed');
 console.log('PASS: source fixture suite and Copilot build; installed packages untouched');
}finally{rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
