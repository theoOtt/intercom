import {atomic,renewConnection} from './session-store.mjs';
import {getDeliveryCursor} from './chat-db.mjs';
import { randomUUID } from "node:crypto";
var CONSUMER = "codex-app-server";
var receiptFor = (db, identity, id) => db.prepare("SELECT * FROM delivery_receipts WHERE identity=? AND message_id=?").get(identity, id);
var attemptFor = (db, identity, id) => db.prepare("SELECT * FROM delivery_attempts WHERE identity=? AND message_id=?").get(identity, id);
var blockedReceipt = (receipt) => ["submitting", "uncertain"].includes(receipt?.state);
function advanceCursor(db, chat, identity, id) {
  db.prepare(`UPDATE delivery_cursors SET last_read_id=?
    WHERE chat=? AND identity=? AND consumer=? AND last_read_id<?`).run(id, chat, identity, CONSUMER, id);
}
function eligible(db, identity, chat, id) {
  const cursor = getDeliveryCursor(db, chat, identity, CONSUMER);
  return cursor !== null && cursor < id && Boolean(db.prepare(`SELECT 1 FROM seats s
    JOIN connection_leases l ON l.identity=s.identity AND l.role='bridge' AND l.connection_id=s.connection_id
    WHERE s.identity=? AND s.chat=? AND l.expires_at>?`).get(identity, chat, Date.now()));
}
function putAttempt(db, { identity: identity, id, attemptId, mode, phase, ownerIdentity, ownerRole, ownerConnection }) {
  db.prepare(`INSERT INTO delivery_attempts VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(identity,message_id) DO UPDATE SET attempt_id=excluded.attempt_id,
    mode=excluded.mode,phase=excluded.phase,owner_identity=excluded.owner_identity,
    owner_role=excluded.owner_role,owner_connection=excluded.owner_connection`).run(identity, id, attemptId, mode, phase, ownerIdentity, ownerRole, ownerConnection);
}
function setReceipt(db, identity, id, chat, state, detail, turnId = null) {
  db.prepare(`INSERT INTO delivery_receipts VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(identity,message_id) DO UPDATE SET chat=excluded.chat,state=excluded.state,
    turn_id=excluded.turn_id,detail=excluded.detail,updated_at=excluded.updated_at`).run(identity, id, chat, state, turnId, detail, Date.now());
}
function ownsAttempt(db, identity, id, attemptId) {
  return attemptFor(db, identity, id)?.attempt_id === attemptId;
}
function deliveryStatus(db, identity, id) {
  const receipt = receiptFor(db, identity, id), attempt = attemptFor(db, identity, id);
  const live = attempt && db.prepare(`SELECT 1 FROM connection_leases WHERE identity=? AND role=?
    AND connection_id=? AND expires_at>?`).get(attempt.owner_identity, attempt.owner_role, attempt.owner_connection, Date.now());
  let status = receipt?.state || "pending", needsReconciliation = false;
  if (receipt?.state === "uncertain") {
    status = "outcome unknown";
    needsReconciliation = true;
  } else if (receipt?.state === "submitting") {
    if (live && attempt?.phase === "native_reserved") status = "reserved for native handoff; awaiting sender outcome";
    else if (live && attempt?.phase === "ipc_sending") status = "sending; awaiting Desktop response";
    else if (live && attempt?.mode === 'queue' && attempt?.phase === 'queue_sending') status = 'sending; awaiting durable queue acceptance';
    else {
      status = "abandoned/legacy submission; outcome unknown";
      needsReconciliation = true;
    }
  } else if (receipt?.state === "pending" && live && attempt?.phase === "discovering") status = "looking for Desktop owner";
  return { status, needsReconciliation, receipt };
}
function reserveNative(db, { sender, connection: connection, messageId }) {
  return atomic(db, () => {
    renewConnection(db, sender, "bridge", connection);
    if (!sender.startsWith("codex:")) throw new Error("Native handoff requires a Codex sender with Desktop app tools");
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId);
    if (!row || row.sender_identity !== sender) throw new Error("Only the original sender can prepare this message");
    if (!row.to_identity?.startsWith("codex:")) throw new Error("Native handoff currently requires a directed Codex recipient");
    const recipient = row.to_identity, receipt = receiptFor(db, recipient, messageId);
    if (receipt?.state === "accepted") return { status: "accepted", message_id: messageId };
    if (blockedReceipt(receipt)) return { status: "blocked", message_id: messageId, delivery: deliveryStatus(db, recipient, messageId) };
    if (!eligible(db, recipient, row.chat, messageId)) return { status: "not_eligible", message_id: messageId };
    const older = db.prepare(`SELECT m.id FROM messages m JOIN delivery_cursors c
      ON c.chat=m.chat AND c.identity=? AND c.consumer=?
      WHERE m.id>c.last_read_id AND m.id<? AND m.sender_identity IS NOT ?
      AND (m.to_identity IS NULL OR m.to_identity=?)
      AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.identity=? AND s.chat=m.chat)
      ORDER BY m.id LIMIT 1`).get(recipient, CONSUMER, messageId, recipient, recipient, recipient);
    if (older) return { status: "blocked_by_earlier_message", message_id: messageId, earlier_message_id: older.id };
    const relay = db.prepare(`SELECT connection_id FROM connection_leases WHERE identity=? AND role='relay'
      AND binding_id IS NULL AND expires_at>?`).get(recipient, Date.now());
    if (!relay)
      return { status: "not_desktop_relay", message_id: messageId };
    const activeAttempt = attemptFor(db, recipient, messageId);
    if (!activeAttempt || activeAttempt.mode !== "ipc" || activeAttempt.owner_identity !== recipient || activeAttempt.owner_role !== "relay" || activeAttempt.owner_connection !== relay.connection_id)
      return { status: "receiver_not_ready", message_id: messageId, instruction: "The recipient must run the updated Desktop relay and attempt this message before native handoff can be reserved." };
    const token = randomUUID();
    putAttempt(db, {
      identity: recipient,
      id: messageId,
      attemptId: token,
      mode: "native",
      phase: "native_reserved",
      ownerIdentity: sender,
      ownerRole: "bridge",
      ownerConnection: connection
    });
    setReceipt(db, recipient, messageId, row.chat, "submitting", "native handoff reserved; no automatic retry");
    return { status: "reserved", message_id: messageId, token, thread_id: recipient.slice(6), row };
  });
}
function finishNative(db, { sender, connection: connection, messageId, token, outcome, result }) {
  return atomic(db, () => {
    renewConnection(db, sender, "bridge", connection);
    if (!["accepted", "not_sent", "uncertain"].includes(outcome)) throw new Error("Invalid native handoff outcome");
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId);
    if (!row || row.sender_identity !== sender || !row.to_identity) throw new Error("Message not owned by this sender");
    const a = attemptFor(db, row.to_identity, messageId);
    if (!a || a.mode !== "native" || a.attempt_id !== token || a.owner_identity !== sender || a.owner_connection !== connection)
      throw new Error("Native handoff token/connection mismatch; inspect the original attempt before retrying");
    if (a.phase !== "native_reserved") {
      if (a.phase === `native_${outcome}`) return { status: receiptFor(db, row.to_identity, messageId).state, message_id: messageId };
      throw new Error("Native handoff already completed with a different outcome");
    }
    if (outcome === "accepted" && result?.threadId !== row.to_identity.slice(6)) throw new Error("Native tool result must identify the exact recipient task");
    const state = outcome === "accepted" ? "accepted" : outcome === "not_sent" ? "pending" : "uncertain";
    const detail = outcome === "accepted" ? "sender reported native tool acceptance; model reading not independently confirmed" : outcome === "not_sent" ? "sender confirmed native tool was never invoked" : "native tool outcome unknown; do not resend";
    setReceipt(db, row.to_identity, messageId, row.chat, state, detail);
    db.prepare("UPDATE delivery_attempts SET phase=? WHERE identity=? AND message_id=?").run(`native_${outcome}`, row.to_identity, messageId);
    if (state === "accepted") advanceCursor(db, row.chat, row.to_identity, messageId);
    return { status: state, message_id: messageId };
  });
}

export {advanceCursor, eligible, putAttempt, setReceipt, ownsAttempt, deliveryStatus, reserveNative, finishNative, receiptFor, attemptFor, blockedReceipt};
