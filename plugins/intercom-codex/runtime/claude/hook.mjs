// Host-launched, bounded asyncRewake receiver. No daemon and no timed polling.
import {DatabaseSync} from 'node:sqlite';
import {watch, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UUID, hookConfig, configPath, route, acknowledge, reserve, notice, RECEIVE_TOOLS, toolProof} from './delivery.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) process.exit(1);
}
let event;
try { event = JSON.parse(raw || '{}'); } catch { process.exit(1); }
if (event.agent_id || !UUID.test(event.session_id || '') ||
    !['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(event.hook_event_name)) process.exit(0);
const LISTEN_TOOLS = ['mcp__intercom__listen', 'mcp__plugin_intercom_intercom__listen'];
if (event.hook_event_name === 'PostToolUse' && ![...RECEIVE_TOOLS, ...LISTEN_TOOLS].includes(event.tool_name)) process.exit(0);
let config;
try { config = hookConfig(); } catch { process.stderr.write('Intercom Claude hooks unavailable; no channel fallback or receipt retry was attempted\n'); process.exit(1); }
if (!config) process.exit(0);
const identity = 'claude:' + event.session_id;
const original = lstatSync(config.database);
if (!original.isFile() || original.isSymbolicLink() || original.uid !== process.getuid()) throw Error('Unsafe Intercom database');
const db = new DatabaseSync(config.database);
db.exec('PRAGMA busy_timeout=100');
let current = route(db, identity, config);
// The MCP bridge must first bind the host's actual session UUID and select this
// generation. A hook never invents a bridge attachment or adopts an old route.
if (!current) { db.close(); process.exit(0); }
if (event.hook_event_name === 'PostToolUse') {
  if (LISTEN_TOOLS.includes(event.tool_name)) {
    const proof = toolProof(event.tool_response, 'intercom_listen');
    if (proof?.reader_identity !== identity || proof.generation !== current.generation || proof.connection_id !== current.connection_id || event.tool_response?.isError === true) { db.close(); process.exit(0); }
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      const valid = acknowledge(db, identity, current, event);
      db.exec('COMMIT');
      if (!valid) { db.close(); process.exit(0); }
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
}
mkdirSync(config.stateDir, {recursive: true, mode: 0o700});
const state = lstatSync(config.stateDir);
if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || state.mode & 0o077) throw Error('Unsafe Intercom Claude wait directory');
const lock = join(config.stateDir, `wait-${event.session_id}-${current.connection_id}.json`);
const nonce = randomUUID();
let fd;
try {
  fd = openSync(lock, 'wx', 0o600);
  writeSync(fd, JSON.stringify({pid: process.pid, nonce, generation: config.generation}));
} catch (error) {
  db.close();
  if (error.code === 'EEXIST') process.exit(0);
  throw error;
} finally { if (fd !== undefined) closeSync(fd); }
let done = false, debounce, timeout;
const watches = new Map();
function finish(id, failed = false) {
  if (done) return;
  done = true;
  clearTimeout(debounce); clearTimeout(timeout);
  for (const entry of watches.values()) entry.handle.close();
  db.close();
  try { if (JSON.parse(readFileSync(lock, 'utf8')).nonce === nonce) unlinkSync(lock); } catch {}
  if (id) {
    process.stderr.write(notice(id));
    process.exitCode = 2;
  } else if (failed) {
    process.stderr.write('Intercom Claude wait stopped; delivery receipts remain unchanged and channel fallback is disabled\n');
    process.exitCode = 1;
  }
}
function scan() {
  if (done) return;
  let transaction = false;
  try {
    const selected = hookConfig(config.database);
    const stat = lstatSync(config.database);
    if (!selected || selected.generation !== config.generation || stat.dev !== original.dev || stat.ino !== original.ino) { finish(); return; }
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const active = route(db, identity, config);
    if (!active || active.connection_id !== current.connection_id) {
      db.exec('COMMIT'); transaction = false; finish(); return;
    }
    const id = reserve(db, identity, active);
    db.exec('COMMIT'); transaction = false;
    if (id) finish(id);
  } catch {
    if (transaction) try { db.exec('ROLLBACK'); } catch {}
    finish(undefined, true);
  }
}
function changed() {
  if (done || debounce) return;
  debounce = setTimeout(() => { debounce = undefined; scan(); }, 25);
}
const files = [config.database, config.database + '-wal', configPath()];
function arm() {
  for (const path of files) {
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    const key = `${stat.dev}:${stat.ino}`;
    if (watches.get(path)?.key === key) continue;
    watches.get(path)?.handle.close();
    const handle = watch(path, changed); handle.on('error', () => finish(undefined, true));
    watches.set(path, {key, handle});
  }
}
for (const path of new Set(files.map(dirname))) {
  const handle = watch(path, () => { try { arm(); changed(); } catch { finish(undefined, true); } });
  handle.on('error', () => finish(undefined, true));
  watches.set(path, {key: 'directory', handle});
}
arm();
// A bounded listener expires quietly. Never create periodic empty idle wakes.
// The next genuine lifecycle event or explicit listen call can rearm it.
timeout = setTimeout(() => finish(), config.waitTimeoutMs - Math.min(30000, Math.floor(config.waitTimeoutMs / 4)));
process.once('SIGTERM', () => finish()); process.once('SIGINT', () => finish());
scan();
