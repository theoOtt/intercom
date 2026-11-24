// One event-driven async hook per enrolled receiver's real active turn.
import {DatabaseSync} from 'node:sqlite';
import {watch, lstatSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync} from 'node:fs';
import {dirname, join, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deliveryConfig, deliveryConfigPath, UUID, reserveBusyRow, deliveryNotice,
  activeBusyTurn, busyTurnRecord, waitTimeout, deliveryUpkeepNotice} from './delivery-core.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) process.exit(2);
}
const event = JSON.parse(raw || '{}');
if (event.agent_id || !UUID.test(event.session_id || '') || !UUID.test(event.turn_id || '') ||
    !['UserPromptSubmit', 'PostToolUse'].includes(event.hook_event_name)) process.exit(0);
// Rearm only after the real bounded receive tool, never an unrelated tool.
if (event.hook_event_name === 'PostToolUse' && !['mcp__intercom__receive', 'mcp__intercom__listen'].includes(event.tool_name)) process.exit(0);
if (event.tool_name === 'mcp__intercom__listen') {
  const proof = event.tool_response?.structuredContent?.intercom_listen;
  if (proof?.reader_identity !== 'codex:' + event.session_id || proof.turn_id !== event.turn_id) process.exit(0);
}
const config = deliveryConfig(event.session_id);
if (!config || config.busyHooks !== true || !isAbsolute(config.stateDir || '')) process.exit(0);
const ttl = waitTimeout(config);
if (event.tool_name === 'mcp__intercom__listen' && event.tool_response.structuredContent.intercom_listen.generation !== config.generation) process.exit(0);
const renewalGrace = config.renewalGraceMs ?? 30000;
if (!Number.isFinite(renewalGrace) || renewalGrace < 1000 || renewalGrace > 60000) throw Error('Invalid Intercom renewal grace');
mkdirSync(config.stateDir, {recursive: true, mode: 0o700});
const state = lstatSync(config.stateDir);
if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o077))
  throw Error('Unsafe private Intercom wait directory');
const identity = 'codex:' + event.session_id;
const lock = join(config.stateDir, `wait-${event.session_id}-${event.turn_id}.json`);
const nonce = randomUUID();
let fd;
try {
  fd = openSync(lock, 'wx', 0o600);
  writeSync(fd, JSON.stringify({pid: process.pid, nonce, threadId: event.session_id,
    turnId: event.turn_id, generation: config.generation, createdAt: Date.now(), expiresAt: Date.now() + ttl}));
} catch (error) {
  if (error.code === 'EEXIST') process.exit(0);
  throw error;
} finally { if (fd !== undefined) closeSync(fd); }

function releaseOwnedLock() {
  try { if (JSON.parse(readFileSync(lock, 'utf8')).nonce === nonce) unlinkSync(lock); } catch {}
}
let initial, db;
try {
  initial = lstatSync(config.database);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== process.getuid())
    throw Error('Unsafe Intercom database');
  db = new DatabaseSync(config.database);
  db.exec('PRAGMA busy_timeout=100');
} catch (error) { releaseOwnedLock(); throw error; }
const watches = new Map();
let done = false, debounce, timeout, startupTimeout, armed = false, seenActive = false;

function finish(id, upkeep = false) {
  if (done) return;
  done = true;
  clearTimeout(debounce);
  clearTimeout(timeout);
  clearTimeout(startupTimeout);
  for (const entry of watches.values()) entry.handle.close();
  // Releasing a routing lease never releases a submitting/uncertain receipt.
  if (!id && !upkeep) {
    try {
      db.prepare('UPDATE intercom_busy_turns SET lease_until=0 WHERE identity=? AND turn_id=? AND generation=?')
        .run(identity, event.turn_id, config.generation);
    } catch {}
  }
  db.close();
  releaseOwnedLock();
  if (id || upkeep) process.stdout.write(JSON.stringify({hookSpecificOutput: {
    hookEventName: event.hook_event_name, additionalContext: upkeep ? deliveryUpkeepNotice() : deliveryNotice(id)
  }}));
}

function scan() {
  if (done) return;
  let transaction = false;
  try {
    const current = deliveryConfig(event.session_id);
    if (!current || current.busyHooks !== true || current.generation !== config.generation) {
      finish(); return;
    }
    const stat = lstatSync(config.database);
    if (stat.dev !== initial.dev || stat.ino !== initial.ino)
      throw Error('Intercom database replaced; wait stopped for review');
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    let active = activeBusyTurn(db, identity);
    // A genuine receive/listen PostToolUse is a new safe point in this exact
    // current turn, even when an earlier routing lease expired during a long tool.
    if (!active && event.hook_event_name === 'PostToolUse') {
      const record = busyTurnRecord(db, identity);
      if (record?.turn_id === event.turn_id && record.generation === config.generation) {
        db.prepare('UPDATE intercom_busy_turns SET lease_until=? WHERE identity=? AND turn_id=? AND generation=?')
          .run(Date.now() + ttl, identity, event.turn_id, config.generation);
        active = activeBusyTurn(db, identity);
      }
    }
    const sameTurn = active?.turn_id === event.turn_id && active.generation === config.generation;
    if (sameTurn) {
      seenActive = true;
      clearTimeout(startupTimeout);
      if (!armed) {
        db.prepare('UPDATE intercom_busy_turns SET lease_until=? WHERE identity=? AND turn_id=? AND generation=?')
          .run(Date.now() + ttl, identity, event.turn_id, config.generation);
        armed = true;
      }
    }
    const id = sameTurn ? reserveBusyRow(db, identity, event.turn_id, config) : null;
    db.exec('COMMIT');
    transaction = false;
    if (id) finish(id);
    else if (seenActive && !sameTurn) finish();
  } catch (error) {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    process.stderr.write('Intercom busy wait stopped; delivery receipts remain unchanged\n');
    finish();
  }
}

// Bound latency from the FIRST event. Continuous WAL activity cannot keep
// postponing this scan. The delay lets the triggering write commit first.
function changed() {
  if (done || debounce) return;
  debounce = setTimeout(() => { debounce = undefined; scan(); }, 25);
}

const watchedFiles = [config.database, config.database + '-wal', deliveryConfigPath, config.registry];
function armFiles() {
  for (const file of watchedFiles) {
    let stat;
    try { stat = lstatSync(file); }
    catch {
      if (watches.has(file)) { watches.get(file).handle.close(); watches.delete(file); }
      continue;
    }
    const key = `${stat.dev}:${stat.ino}`;
    if (watches.get(file)?.key === key) continue;
    if (watches.has(file)) watches.get(file).handle.close();
    const handle = watch(file, changed);
    handle.on('error', () => finish());
    watches.set(file, {key, handle});
  }
}
for (const directory of new Set(watchedFiles.map(dirname))) {
  const handle = watch(directory, () => { try { armFiles(); changed(); } catch { finish(); } });
  handle.on('error', () => finish());
  watches.set(directory, {key: 'directory', handle});
}
armFiles();
startupTimeout = setTimeout(() => { if (!seenActive) finish(); }, 5000);
// Finish before the platform command timeout, then rearm through a genuine MCP
// listen call at the next active-turn safe point. Never wake a genuinely idle turn.
timeout = setTimeout(() => {
  try {
    const current = deliveryConfig(event.session_id);
    const active = activeBusyTurn(db, identity);
    if (!current || current.busyHooks !== true || current.generation !== config.generation ||
        active?.turn_id !== event.turn_id || active.generation !== config.generation) { finish(); return; }
    db.prepare('UPDATE intercom_busy_turns SET lease_until=? WHERE identity=? AND turn_id=? AND generation=?')
      .run(Date.now() + renewalGrace, identity, event.turn_id, config.generation);
    finish(undefined, true);
  } catch { finish(); }
}, ttl - Math.min(30000, Math.floor(ttl / 4)));
process.once('SIGTERM', () => finish());
process.once('SIGINT', () => finish());
scan();
