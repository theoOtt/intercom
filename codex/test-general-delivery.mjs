import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'intercom-general-'));
const configPath = join(root, 'delivery.json');
process.env.INTERCOM_DELIVERY_CONFIG = configPath;
const core = await import('./delivery-core.mjs');
const {DesktopRelay} = await import('./desktop-relay.mjs');
const {openDb, sendMessage, getDeliveryCursor} = await import('../bridge/chat-db.mjs');
const {claimConnection, attachRooms, joinRoom, leaveRoom} = await import('../bridge/session-store.mjs');
let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log('PASS:', name); }

async function fixture(fn) {
  const dir = mkdtempSync(join(root, 'case-'));
  const dbPath = join(dir, 'chat.db'), registry = join(dir, 'registry.json'), stateDir = join(dir, 'waiters');
  mkdirSync(stateDir, {mode: 0o700});
  const db = openDb(dbPath), ids = [randomUUID(), randomUUID(), randomUUID()];
  const identities = ids.map(id => 'codex:' + id), connections = ids.map(() => randomUUID());
  const rooms = ['room-' + randomUUID(), 'UNTRUSTED_ROOM_' + randomUUID()];
  identities.forEach((identity, index) => {
    claimConnection(db, identity, 'bridge', connections[index]);
    attachRooms(db, identity, connections[index], null);
    joinRoom(db, identity, connections[index], rooms[0], 'Member-' + index);
    if (index < 2) joinRoom(db, identity, connections[index], rooms[1], 'Other-' + index);
  });
  const config = {enabled: true, version: 1, mode: 'enrolled-desktop', busyHooks: true,
    idleQueue: true, database: dbPath, registry, stateDir, generation: randomUUID(),
    afterMessageId: 0, waitTimeoutMs: 1500};
  const save = () => writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
  save();
  writeFileSync(registry, JSON.stringify(Object.fromEntries(ids.slice(0, 2)
    .map(id => [id, {source: 'executor-tool-metadata', registeredAt: Date.now()}]))), {mode: 0o600});
  const turns = ids.map(() => randomUUID()), children = [], relays = [];
  const event = (index = 0, extra = {}) => ({hook_event_name: 'UserPromptSubmit',
    session_id: ids[index], turn_id: turns[index], ...extra});
  const run = (script, input) => {
    const result = spawnSync(process.execPath, [new URL(script, import.meta.url).pathname],
      {input: JSON.stringify(input), encoding: 'utf8', env: process.env});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const start = (index = 0) => run('./busy-turn.mjs', event(index));
  const send = (body, {room = rooms[0], sender = 'claude:' + randomUUID(), target = identities[0], seat = 'Peer'} = {}) =>
    sendMessage(db, room, seat, body, {senderIdentity: sender,
      toIdentity: target, toSeat: target === null ? null : 'recipient'});
  const receipt = (id, index = 0) => db.prepare('SELECT * FROM delivery_receipts WHERE identity=? AND message_id=?')
    .get(identities[index], id);
  const wait = (index = 0, extra = {}) => {
    const child = spawn(process.execPath, [new URL('./busy-wait.mjs', import.meta.url).pathname],
      {env: process.env, stdio: ['pipe', 'pipe', 'pipe']});
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.stdin.end(JSON.stringify(event(index, extra)));
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('fixture wait exceeded bound')); }, 4000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(stderr)); });
    });
    return {child, completed};
  };
  const lockReady = async () => {
    if (readdirSync(stateDir).length) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(Error('waiter did not arm')); }, 2000);
      const watcher = watch(stateDir, () => {
        if (readdirSync(stateDir).length) { clearTimeout(timer); watcher.close(); resolve(); }
      });
      if (readdirSync(stateDir).length) { clearTimeout(timer); watcher.close(); resolve(); }
    });
  };
  const relay = (index = 0, q = null) => {
    let submissions = 0;
    const instance = new DesktopRelay({db, identity: identities[index], bridgeConnection: connections[index],
      queueFallback: q, client: {close() {}, async deliver(t, p, guard) {
        if (q) throw Object.assign(Error('refused legacy socket'), {notSubmitted: true, intercomLegacySocketRefused: true});
        if (!guard()) throw Object.assign(Error('guard'), {notSubmitted: true});
        submissions++; return {turnId: randomUUID(), method: 'fixture-ipc'};
      }}});
    relays.push(instance); return {instance, count: () => submissions};
  };
  try { await fn({db, ids, identities, connections, rooms, turns, config, save, event,
    run, start, send, receipt, wait, lockReady, relay, stateDir}); }
  finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    for (const instance of relays) instance.stop();
    db.close(); rmSync(dir, {recursive: true, force: true});
  }
}

try {
  await test('enrollment and actual root UUID required; fork identity has no inherited authority', () => fixture(async f => {
    assert(core.deliveryConfig(f.ids[0])); assert.equal(core.deliveryConfig(f.ids[2]), null);
    f.run('./busy-turn.mjs', f.event(0, {agent_id: randomUUID()}));
    assert.equal(core.activeBusyTurn(f.db, f.identities[0]), null);
  }));
  await test('directed receive denies other recipient, absent room and ambiguous legacy recipient', () => fixture(async f => {
    const direct = f.send('private');
    assert.equal(core.receivedRow(f.db, f.identities[0], direct).id, direct);
    assert.throws(() => core.receivedRow(f.db, f.identities[1], direct));
    const otherRoom = f.send('other room', {room: f.rooms[1]});
    assert.throws(() => core.receivedRow(f.db, f.identities[2], otherRoom));
    f.db.prepare("INSERT INTO messages(chat,seat,sender_identity,to_seat,to_identity,type,body,ts) VALUES(?,?,?,?,?,'msg',?,?)")
      .run(f.rooms[0], 'legacy', null, 'unknown recipient', null, 'ambiguous', new Date().toISOString());
    const id = Number(f.db.prepare('SELECT max(id) id FROM messages').get().id);
    assert.throws(() => core.receivedRow(f.db, f.identities[0], id));
    assert.throws(() => core.receivedRow(f.db, f.identities[1], id));
  }));
  await test('visible broadcasts reach each current member; null legacy sender preserves seat self-filter', () => fixture(async f => {
    const id = f.send('broadcast', {target: null});
    assert.equal(core.receivedRow(f.db, f.identities[0], id).id, id);
    assert.equal(core.receivedRow(f.db, f.identities[1], id).id, id);
    f.db.prepare("INSERT INTO messages(chat,seat,sender_identity,to_seat,to_identity,type,body,ts) VALUES(?,?,NULL,NULL,NULL,'msg',?,?)")
      .run(f.rooms[0], 'Member-0', 'unknown legacy sender', new Date().toISOString());
    const legacy = Number(f.db.prepare('SELECT max(id) id FROM messages').get().id);
    assert.throws(() => core.receivedRow(f.db, f.identities[0], legacy));
    assert.equal(core.receivedRow(f.db, f.identities[1], legacy).id, legacy);
    leaveRoom(f.db, f.identities[1], f.connections[1], f.rooms[0]);
    assert.throws(() => core.receivedRow(f.db, f.identities[1], id));
  }));
  await test('async waiter emits numeric-only fixed notice and exact real receive metadata acknowledges once', () => fixture(async f => {
    f.start(); const waiting = f.wait(); await f.lockReady();
    const body = 'PRIVATE_BODY_' + randomUUID(), id = f.send(body, {room: f.rooms[1]});
    const output = await waiting.completed;
    assert(output.includes('message_id=' + id));
    assert(!output.includes(body)); assert(!output.includes(f.rooms[1]));
    assert.equal(f.receipt(id).state, 'submitting');
    f.run('./busy-receive.mjs', f.event(0, {hook_event_name: 'PostToolUse', tool_name: 'mcp__intercom__receive',
      tool_response: {structuredContent: {intercom_receive: {reader_identity: f.identities[0], message_id: id}}}}));
    assert.equal(f.receipt(id).state, 'accepted');
    assert.equal(getDeliveryCursor(f.db, f.rooms[1], f.identities[0], 'codex-app-server'), id);
    assert.equal(readdirSync(f.stateDir).length, 0);
  }));
  await test('one active waiter per turn; unrelated tool creates no listener; exact Stop cleans up', () => fixture(async f => {
    f.start(); assert.equal(f.run('./busy-wait.mjs', f.event(0, {hook_event_name: 'PostToolUse', tool_name: 'Bash'})), '');
    assert.equal(readdirSync(f.stateDir).length, 0);
    const waiting = f.wait(); await f.lockReady();
    assert.equal(f.run('./busy-wait.mjs', f.event()), '');
    assert.equal(readdirSync(f.stateDir).length, 1);
    f.run('./busy-turn.mjs', f.event(0, {hook_event_name: 'Stop'}));
    assert.equal(await waiting.completed, ''); assert.equal(readdirSync(f.stateDir).length, 0);
    assert.equal(core.activeBusyTurn(f.db, f.identities[0]), null);
  }));
  await test('sustained unrelated WAL activity cannot starve pending receiver notification', () => fixture(async f => {
    f.start(); const waiting = f.wait(); await f.lockReady();
    const began = Date.now();
    const noise = setInterval(() => f.send('noise', {target: f.identities[1]}), 2);
    const id = f.send('target');
    try { const out = await waiting.completed; assert(out.includes('message_id=' + id)); assert(Date.now() - began < 1000); }
    finally { clearInterval(noise); }
  }));
  await test('idle queue supports fresh multiple rooms, Claude/Codex senders and broadcast without allowlist', () => fixture(async f => {
    const notices = [];
    const q = {threadId: f.ids[0], afterMessageId: 0, async deliver(target, notice, guard) {
      assert(guard()); notices.push(notice); return {queued: true, threadId: target};
    }};
    const relay = f.relay(0, q).instance;
    f.send('Claude'); f.send('Codex', {room: f.rooms[1], sender: 'codex:' + randomUUID()});
    f.send('broadcast', {target: null});
    await relay.tick(); await relay.tick(); await relay.tick();
    assert.equal(notices.length, 3); assert(notices.every(notice => !notice.includes(f.rooms[1])));
  }));
  await test('active marker guards idle transport; ended or expired routing lease restores idle', () => fixture(async f => {
    f.start(); const id = f.send('pending'), relay = f.relay();
    await relay.instance.tick(); assert.equal(relay.count(), 0);
    f.run('./busy-turn.mjs', f.event(0, {hook_event_name: 'Stop', turn_id: randomUUID()}));
    await relay.instance.tick(); assert.equal(relay.count(), 0);
    f.db.prepare('UPDATE intercom_busy_turns SET lease_until=0 WHERE identity=?').run(f.identities[0]);
    await relay.instance.tick(); assert.equal(relay.count(), 1); assert.equal(f.receipt(id).state, 'accepted');
  }));
  for (const state of ['accepted', 'submitting', 'uncertain']) await test(state + ' receipt is never replayed or cleared', () => fixture(async f => {
    f.start(); const id = f.send('old state');
    f.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)').run(f.identities[0], id, f.rooms[0], state, null, 'existing', 1);
    const output = f.run('./busy-receive.mjs', f.event(0, {hook_event_name: 'PostToolUse', tool_name: 'mcp__intercom__receive'}));
    assert.equal(output, ''); assert.equal(f.receipt(id).state, state);
  }));
  await test('pre-cutover visible row stays barrier without replaying it or skipping to fresh row', () => fixture(async f => {
    f.send('pre-cutover'); f.config.afterMessageId = 1; f.save(); f.start(); f.send('fresh');
    f.db.exec('BEGIN IMMEDIATE'); assert.equal(core.reserveBusyRow(f.db, f.identities[0], f.turns[0], f.config), null); f.db.exec('COMMIT');
    assert.equal(f.db.prepare('SELECT count(*) n FROM delivery_receipts').get().n, 0);
  }));
  await test('cutover also prevents supported IPC from submitting old unseen rows', () => fixture(async f => {
    const id = f.send('before new route'); f.config.afterMessageId = id; f.save();
    const relay = f.relay(); await relay.instance.tick();
    assert.equal(relay.count(), 0); assert.equal(f.receipt(id), undefined);
  }));
  await test('expired routing lease preserves any unknown hook receipt independently', () => fixture(async f => {
    f.start(); const id = f.send('unknown');
    f.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)')
      .run(f.identities[0], id, f.rooms[0], 'uncertain', null, 'unknown hook outcome', 1);
    f.db.prepare('UPDATE intercom_busy_turns SET lease_until=0').run();
    const relay = f.relay(); await relay.instance.tick();
    assert.equal(relay.count(), 0); assert.equal(f.receipt(id).state, 'uncertain');
  }));
  await test('active-window upkeep rearms through real-turn listen proof without making peer messages', () => fixture(async f => {
    f.config.waitTimeoutMs = 1000; f.config.renewalGraceMs = 1000; f.save(); f.start();
    const first = f.wait(); await f.lockReady();
    const upkeep = await first.completed;
    assert(upkeep.includes('listen tool')); assert(!upkeep.includes('message_id='));
    assert.equal(f.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
    assert.equal(readdirSync(f.stateDir).length, 0);
    // A long tool may return after the routing grace. Its actual current turn
    // is still verified by the listen PostToolUse, not inferred from a timer.
    f.db.prepare('UPDATE intercom_busy_turns SET lease_until=0').run();
    const next = f.wait(0, {hook_event_name: 'PostToolUse', tool_name: 'mcp__intercom__listen',
      tool_response: {structuredContent: {intercom_listen: {
        reader_identity: f.identities[0], turn_id: f.turns[0], generation: f.config.generation}}}});
    await f.lockReady(); const id = f.send('after upkeep');
    assert((await next.completed).includes('message_id=' + id));
  }));
  await test('ended turn emits neither upkeep nor an idle model message', () => fixture(async f => {
    f.config.waitTimeoutMs = 1000; f.save(); f.start();
    const waiting = f.wait(); await f.lockReady();
    f.run('./busy-turn.mjs', f.event(0, {hook_event_name: 'Stop'}));
    assert.equal(await waiting.completed, '');
    assert.equal(f.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
    assert.equal(core.activeBusyTurn(f.db, f.identities[0]), null);
  }));
  await test('accepted old receipt with lagging cursor is advanced without changing or resending it', () => fixture(async f => {
    const old = f.send('already accepted');
    f.db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)')
      .run(f.identities[0], old, f.rooms[0], 'accepted', 'old-turn', 'preserved', 1);
    f.config.afterMessageId = old; f.save(); f.start();
    const fresh = f.send('fresh');
    f.db.exec('BEGIN IMMEDIATE');
    assert.equal(core.reserveBusyRow(f.db, f.identities[0], f.turns[0], f.config), fresh);
    f.db.exec('COMMIT');
    assert.equal(f.receipt(old).detail, 'preserved'); assert.equal(f.receipt(old).updated_at, 1);
    assert.equal(f.receipt(fresh).state, 'submitting');
  }));
  console.log(`${tests} general delivery tests passed`);
} finally { rmSync(root, {recursive: true, force: true}); }
