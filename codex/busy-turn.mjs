import {DatabaseSync} from 'node:sqlite';
import {deliveryConfig, UUID, busySchema, waitTimeout} from './delivery-core.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) process.exit(2);
}
const event = JSON.parse(raw || '{}');
if (event.agent_id || !UUID.test(event.session_id || '')) process.exit(0);
const config = deliveryConfig(event.session_id);
if (!config || config.busyHooks !== true) process.exit(0);
const kind = event.hook_event_name;
if (!['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'].includes(kind) ||
    (kind !== 'SessionEnd' && !UUID.test(event.turn_id || ''))) process.exit(0);

const db = new DatabaseSync(config.database);
const identity = 'codex:' + event.session_id;
db.exec('PRAGMA busy_timeout=100');
try {
  db.exec('BEGIN IMMEDIATE');
  busySchema(db);
  if (kind === 'UserPromptSubmit') {
    if (db.prepare('SELECT 1 FROM subscriptions WHERE identity=? LIMIT 1').get(identity)) {
      const now = Date.now();
      const old = db.prepare('SELECT * FROM intercom_busy_turns WHERE identity=?').get(identity);
      if (!old || old.lease_until <= now) {
        db.prepare(`INSERT INTO intercom_busy_turns VALUES(?,?,?,?,?,?)
          ON CONFLICT(identity) DO UPDATE SET turn_id=excluded.turn_id,
          started_at=excluded.started_at,last_safe_at=excluded.last_safe_at,
          generation=excluded.generation,lease_until=excluded.lease_until`)
          .run(identity, event.turn_id, now, now, config.generation, now + Math.min(waitTimeout(config), 5000));
      } else if (old.turn_id !== event.turn_id || old.generation !== config.generation) {
        process.stderr.write('Intercom busy route still belongs to another active turn; idle queue will resume when its bounded routing lease expires\n');
      }
    }
  } else if (kind === 'SessionEnd') {
    db.prepare('DELETE FROM intercom_busy_turns WHERE identity=? AND generation=?')
      .run(identity, config.generation);
  } else {
    db.prepare('DELETE FROM intercom_busy_turns WHERE identity=? AND turn_id=? AND generation=?')
      .run(identity, event.turn_id, config.generation);
  }
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
} finally {
  db.close();
}
