// Per-user Desktop provisioning. Never trusts hooks or replaces a running job.
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {userInfo} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

export function desktopProvisionPlan({pluginRoot,userHome,database,codexHome=join(userHome,".codex")}) {
  const home=resolve(userHome),db=resolve(database),key=createHash('sha256').update(db).digest('hex').slice(0,12);
  const service=join(home,'.local/share/intercom/desktop-service'),runtime=join(service,'runtime'),state=join(service,key);
  return {home,db,key,service,runtime,state,codexHome:resolve(codexHome),registry:join(state,'registrations.json'),config:join(home,'.config/intercom/desktop-delivery.json'),plist:join(home,'Library/LaunchAgents/com.theoott.intercom.desktop-relay.plist'),pluginRoot};
}
function nativeMacAccount(plan) {
  // userInfo reads the native account database. os.homedir() instead honors HOME.
  return process.platform==='darwin' && resolve(plan.home)===resolve(userInfo().homedir);
}
export function desktopPreflight(plan) {
  if(!nativeMacAccount(plan))return;
  const result=spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/com.theoott.intercom.desktop-relay`],{stdio:'pipe'});
  if(result.status===0)throw Error('Intercom Desktop service is already running. Coordinate the exact relay update before setup: check in-flight receipts, stop only this service, run setup, then bootstrap that service. No service files were replaced.');
  if(result.error||result.status===null||!String(result.stderr||'').includes('Could not find service'))
    throw Error('Cannot establish that the Intercom LaunchAgent is absent; no runtime files were replaced.');
  const ownerFile=join('/private/tmp',`intercom-desktop-${process.getuid()}-${plan.key}`,'owner.json');
  if(existsSync(ownerFile)) {
    let owner;try{owner=JSON.parse(readFileSync(ownerFile,'utf8'))}catch{throw Error('Intercom service owner metadata is unreadable; update held.');}
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.started!=='string')throw Error('Intercom service owner metadata is invalid; update held.');
    const processState=spawnSync('/bin/ps',['-p',String(owner.pid),'-o','lstart='],{encoding:'utf8'});
    if(processState.error||processState.status===null)throw Error('Cannot verify existing Intercom service process; update held.');
    if(processState.status===0&&processState.stdout.trim()===owner.started)
      throw Error('An existing Intercom service process is still live outside the LaunchAgent check; coordinate its exact shutdown before setup.');
    if(processState.status!==0&&processState.status!==1)throw Error('Cannot establish Intercom process absence; update held.');
  }
}
export function desktopConfigurationPreflight(plan) {
  if(existsSync(plan.config)) {
    const config=JSON.parse(readFileSync(plan.config,'utf8'));
    if(config.version!==1||config.mode!=='enrolled-desktop'||config.database!==plan.db||config.registry!==plan.registry||!Number.isSafeInteger(config.afterMessageId)||config.afterMessageId<0||typeof config.generation!=='string')
      throw Error('Existing Desktop configuration needs explicit migration; it and the runtime were preserved.');
    return config;
  }
  const inspection=new DatabaseSync(plan.db,{readOnly:true});let cutoff;
  try {
    cutoff=inspection.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id;
    const registry=existsSync(plan.registry)?JSON.parse(readFileSync(plan.registry,'utf8')):{};
    for(const thread of Object.keys(registry)) {
      const identity='codex:'+thread;
      const pending=inspection.prepare(`SELECT m.id FROM subscriptions s JOIN delivery_cursors c ON c.identity=s.identity AND c.chat=s.chat AND c.consumer='codex-app-server' JOIN messages m ON m.chat=s.chat AND m.id>c.last_read_id LEFT JOIN delivery_receipts r ON r.identity=s.identity AND r.message_id=m.id WHERE s.identity=? AND m.id<=? AND ((m.sender_identity IS NOT NULL AND m.sender_identity!=s.identity) OR (m.sender_identity IS NULL AND m.seat!=s.seat)) AND ((m.to_identity IS NULL AND m.to_seat IS NULL) OR m.to_identity=s.identity) AND (r.state IS NULL OR r.state!='accepted') LIMIT 1`).get(identity,cutoff);
      if(pending)throw Error('Existing enrolled Desktop messages need reconciliation before first generic delivery cutover; no rows, cursors or runtime files changed.');
    }
  } finally {inspection.close();}
  return {version:1,enabled:true,mode:'enrolled-desktop',idleQueue:true,busyHooks:true,database:plan.db,registry:plan.registry,stateDir:join(plan.state,'busy-hooks'),generation:randomUUID(),afterMessageId:cutoff,waitTimeoutMs:7200000};
}
export function provisionDesktop(plan) {
  desktopPreflight(plan);
  const config=desktopConfigurationPreflight(plan); // Validate migrations/receipts before runtime mutation.
  for(const path of [plan.runtime,plan.state,join(plan.home,'.config/intercom')])mkdirSync(path,{recursive:true,mode:0o700});
  for(const name of ['dist','scripts'])cpSync(join(plan.pluginRoot,name),join(plan.runtime,name),{recursive:true});
  if(!existsSync(plan.registry))writeFileSync(plan.registry,'{}\n',{mode:0o600});
  if(!existsSync(plan.config))writeFileSync(plan.config,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  chmodSync(plan.config,0o600);
  if(process.platform!=='darwin')return plan; // Never create a macOS LaunchAgent on other systems.
  mkdirSync(join(plan.home,'Library/LaunchAgents'),{recursive:true,mode:0o700});
  const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const node=process.execPath,entry=join(plan.runtime,'scripts/persistent-service.mjs');
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.theoott.intercom.desktop-relay</string><key>ProgramArguments</key><array><string>${escape(node)}</string><string>${escape(entry)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(plan.home)}</string><key>CODEX_HOME</key><string>${escape(plan.codexHome)}</string><key>CHAT_DB</key><string>${escape(plan.db)}</string><key>INTERCOM_DELIVERY_CONFIG</key><string>${escape(plan.config)}</string></dict><key>StandardOutPath</key><string>${escape(join(plan.state,'service.stdout.log'))}</string><key>StandardErrorPath</key><string>${escape(join(plan.state,'service.stderr.log'))}</string></dict></plist>\n`;
  writeFileSync(plan.plist,plist,{mode:0o600});
  if(nativeMacAccount(plan)) {
    const result=spawnSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plan.plist],{encoding:'utf8'});
    if(result.status!==0)throw Error('Desktop service provisioned but launchctl bootstrap failed; no broader recovery attempted.');
  }
  return plan;
}
