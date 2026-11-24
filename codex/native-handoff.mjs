import {DesktopIpc} from './desktop-ipc.mjs';
import {renewConnection} from '../bridge/session-store.mjs';
import {receiptFor,blockedReceipt,deliveryStatus,eligible,reserveNative,finishNative} from '../bridge/delivery-state.mjs';
import {peerPrompt} from '../bridge/peer-envelope.mjs';
async function nativeHandoff({ db: db, sender, connection: connection, args, enabled = true, clientFactory = () => new DesktopIpc() }) {
  const { action = "status", message_id: messageId } = args;
  if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error("message_id must be a positive integer");
  renewConnection(db, sender, "bridge", connection);
  const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId);
  if (!row || row.sender_identity !== sender) throw new Error("Only the original sender can inspect/hand off this message");
  if (!row.to_identity?.startsWith("codex:")) throw new Error("Native handoff requires a directed Codex recipient");
  if (action === "finish") return finishNative(db, { sender, connection: connection, messageId, token: args.token, outcome: args.outcome, result: args.result });
  if (action === "status") return { message_id: messageId, delivery: deliveryStatus(db, row.to_identity, messageId) };
  if (action !== "prepare") throw new Error("Unknown delivery action");
  if (!sender.startsWith("codex:")) throw new Error("Native preparation requires a Codex sender with the built-in Desktop messaging tool");
  if (!enabled) return { status: "disabled", message_id: messageId };
  const current = receiptFor(db, row.to_identity, messageId);
  if (current?.state === "accepted") return { status: "accepted", message_id: messageId };
  if (blockedReceipt(current)) return { status: "blocked", message_id: messageId, delivery: deliveryStatus(db, row.to_identity, messageId) };
  if (!eligible(db, row.to_identity, row.chat, messageId)) return { status: "not_eligible", message_id: messageId };
  const client = clientFactory();
  try {
    await client.findOwner(row.to_identity.slice(6));
    return { status: "ipc_pending", message_id: messageId, instruction: "Existing Desktop owner found. Leave delivery to IPC; do not forward manually." };
  } catch (e) {
    // Owner discovery is read-only. The refusal marker is produced only by
    // connect() after checking the normal legacy socket's ownership/permissions,
    // before initialize or any task request. Do not generalize other IPC errors.
    const refusedBeforeSubmission = e.intercomLegacySocketRefused === true &&
      e.code === "ECONNREFUSED" && e.syscall === "connect";
    if (e.message !== "no-client-found" && !refusedBeforeSubmission)
      return { status: "unavailable", message_id: messageId, error: e.message };
  } finally {
    client.close();
  }
  const reserved = reserveNative(db, { sender, connection: connection, messageId });
  if (reserved.status !== "reserved") return reserved;
  const { row: stored, ...response } = reserved;
  return {
    ...response,
    native_tool: "send_message_to_thread",
    arguments: { threadId: response.thread_id, prompt: peerPrompt(stored.chat, stored) },
    instruction: "First verify with your normal Desktop read_thread tool that this exact task is active or idle on this same execution host, not unloaded or running in a separate CLI engine. If not verified, report not_sent without sending. Otherwise call the normal Desktop send_message_to_thread tool exactly once with these arguments, preserving approvals and supplying no model/permission overrides. Then call delivery action finish with this token and its actual result. If never invoked, report not_sent. If invoked but outcome is unclear, report uncertain and do not retry."
  };
}

export {nativeHandoff};
