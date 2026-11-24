import {DatabaseSync} from 'node:sqlite';
import {deliveryConfig, UUID, busyTurnRecord, receivedRow, deliveryNotice,
  reserveBusyRow} from './delivery-core.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) process.exit(2);
}
const event = JSON.parse(raw || '{}');
if (event.agent_id || event.hook_event_name !== 'PostToolUse' ||
    event.tool_name !== 'mcp__intercom__receive' ||
    !UUID.test(event.session_id || '') || !UUID.test(event.turn_id || '')) process.exit(0);
const config = deliveryConfig(event.session_id);
if (!config || config.busyHooks !== true) process.exit(0);
const db = new DatabaseSync(config.database);
const identity = 'codex:' + event.session_id;
db.exec('PRAGMA busy_timeout=100');
let chosen;
try {
  db.exec('BEGIN IMMEDIATE');
  const active = busyTurnRecord(db, identity);
  if (active?.turn_id !== event.turn_id || active.generation !== config.generation) {
    db.exec('COMMIT'); process.exit(0);
  }
  db.prepare('UPDATE intercom_busy_turns SET last_safe_at=?,lease_until=? WHERE identity=?')
    .run(Date.now(), Date.now() + 5000, identity);
  // Actual namespaced MCP output metadata, never peer text or hook stdout.
  const proof = event.tool_response?.structuredContent?.intercom_receive;
  if (proof?.reader_identity === identity && Number.isSafeInteger(proof.message_id) &&
      proof.message_id > config.afterMessageId) {
    const id = proof.message_id;
    const attempt = db.prepare(`SELECT * FROM delivery_attempts WHERE identity=?
      AND message_id=? AND mode='hook' AND phase='hook_context_reserved'
      AND owner_connection=?`).get(identity, id, event.turn_id);
    const receipt = db.prepare(`SELECT * FROM delivery_receipts WHERE identity=?
      AND message_id=? AND state='submitting'`).get(identity, id);
    if (attempt && receipt) {
      const row = receivedRow(db, identity, id);
      db.prepare(`UPDATE delivery_receipts SET state='accepted',
        detail='Exact bounded receive tool output acknowledged; model reading not independently confirmed',
        updated_at=? WHERE identity=? AND message_id=?`).run(Date.now(), identity, id);
      db.prepare("UPDATE delivery_attempts SET phase='done' WHERE identity=? AND message_id=?")
        .run(identity, id);
      db.prepare(`UPDATE delivery_cursors SET last_read_id=? WHERE identity=? AND chat=?
        AND consumer='codex-app-server' AND last_read_id<?`).run(id, identity, row.chat, id);
    }
  }
  // A second already-arrived item can be handed off at this same safe point.
  chosen = reserveBusyRow(db, identity, event.turn_id, config);
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
} finally { db.close(); }
if (chosen) process.stdout.write(JSON.stringify({hookSpecificOutput: {
  hookEventName: 'PostToolUse', additionalContext: deliveryNotice(chosen)
}}));
