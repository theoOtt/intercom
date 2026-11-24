import {receivedRow,deliveryConfig,busyTurnRecord} from '../codex/delivery-core.mjs';
import {deliveryStatus} from './delivery-state.mjs';
import {peerPrompt} from './peer-envelope.mjs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {basename,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {mkdirSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {codexThreadId} from './codex-metadata.mjs';
import {DesktopRelay} from '../codex/desktop-relay.mjs';
import {nativeHandoff} from '../codex/native-handoff.mjs';
import {atomic,claimConnection,renewConnection,detachConnection,attachRooms,joinRoom,leaveRoom,liveMemberships,subscriptions} from './session-store.mjs';
import {openDb,listSeats,knownChats,sendMessage,messagesAfter,history,setCursor,whoOnline,getDeliveryCursor,setDeliveryCursor,migrateChat} from './chat-db.mjs';
import {SqliteRetry,isSqliteBusy,recoverOwnedConnections} from './sqlite-recovery.mjs';
import {hookConfig as claudeHookConfig,attachRoute as attachClaudeRoute,route as claudeHookRoute,closeRoute as closeClaudeRoute,receiveProof as claudeReceiveProof} from '../claude/delivery.mjs';

var CHAT_DB = process.env.CHAT_DB || join(homedir(), ".claude", "intercom", "chat.db");
mkdirSync(dirname(CHAT_DB), { recursive: true, mode: 448 });
var FALLBACK_IDENTITY = `process:${process.pid}:${Date.now()}`;
function currentIdentity() {
  const host = server.getClientVersion()?.name || "";
  if (/copilot/i.test(host) || host === 'sdk') {
    const id = host === 'copilot-intercom' ? process.env.INTERCOM_COPILOT_SESSION_ID : process.env.COPILOT_AGENT_SESSION_ID;
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id || '') ? `copilot:${id}` : FALLBACK_IDENTITY;
  }
  if (/claude/i.test(host)) {
    const id = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
    return id ? `claude:${id}` : FALLBACK_IDENTITY;
  }
  if (process.env.CHAT_IDENTITY_FILE) {
    try {
      const fromFile = readFileSync(process.env.CHAT_IDENTITY_FILE, "utf8").trim();
      if (fromFile) return fromFile;
    } catch {
    }
  }
  if (process.env.CHAT_IDENTITY) return process.env.CHAT_IDENTITY;
  if (/codex/i.test(host)) return FALLBACK_IDENTITY;
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude:${process.env.CLAUDE_CODE_SESSION_ID}`;
  if (process.env.CLAUDE_SESSION_ID) return `claude:${process.env.CLAUDE_SESSION_ID}`;
  return FALLBACK_IDENTITY;
}
var log = (m) => process.stderr.write(`[bridge] ${m}
`);
var db = null;
var joined = /* @__PURE__ */ new Map();
var connection = randomUUID();
var identity = null;
var attachmentError = null;
var bridgeRetry = new SqliteRetry();
function bridgeFence() {
  if (bridgeRetry.failures) recoverOwnedConnections(db, identity, [["bridge", connection]]);
  renewConnection(db, identity, "bridge", connection);
  bridgeRetry.clear();
}
// Service workers report terminal attachment state explicitly. Never retry an
// operation here; persisted submitting/uncertain receipts remain quarantined.
function terminalAttachment(message) {
  if (attachmentError) return;
  attachmentError = message;
  desktopRelay?.stop();
  if (process.env.CHAT_SERVICE_WORKER === "1")
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/intercom/worker-terminal",params:{code:"attachment-terminal",message}}) + "\n");
}
function bridgeDatabaseError(error) {
  if (bridgeRetry.defer(error)) {
    log("database busy; automatic bridge retry scheduled");
    return;
  }
  terminalAttachment(error.message);
  log(attachmentError);
}
var conflicts = [];
var metadataIdentity = null;
var desktopRelay = null;
var claudeDelivery = null;
var projectFromRoots = process.env.CHAT_PROJECT_FROM_ROOTS === "1" && !process.env.CHAT && !process.env.CHAT_PROJECT;
var projectReady = !projectFromRoots;
var projectInitialization;
var projectWarning = "";
async function initializeProject() {
  if (projectReady || !server.getClientVersion()) return;
  if (!projectInitialization) projectInitialization = (async () => {
    startupChat = null;
    if (/^(1|true|yes|on)$/i.test(process.env.CHAT_AUTOJOIN_PROJECT ?? "1")) {
      try {
        if (!server.getClientCapabilities()?.roots) throw new Error("host does not expose workspace roots");
        const { roots } = await server.listRoots({}, { timeout: 5e3 });
        if (roots.length !== 1 || !roots[0].uri.startsWith("file:")) throw new Error("workspace root is not unambiguous");
        startupChat = basename(fileURLToPath(roots[0].uri)).replace(/[^a-zA-Z0-9._-]/g, "-");
      } catch (error) {
        projectWarning = `Project autojoin unavailable (${error.message}); use join({chat,seat}). Saved rooms still restore.`;
        log(projectWarning);
      }
    }
    projectReady = true;
  })();
  await projectInitialization;
}
function refreshMemberships() {
  joined.clear();
  for (const row of liveMemberships(db, identity, connection)) {
    joined.set(row.chat, {
      seat: row.seat,
      identity,
      cursor: getDeliveryCursor(db, row.chat, identity, "claude-channel") ?? 0
    });
  }
}
function activateIdentity() {
  if (identity || attachmentError || !bridgeRetry.ready()) return;
  if (!projectReady) return;
  if (!server.getClientVersion()) return;
  const candidate = metadataIdentity || currentIdentity();
  if (/codex/i.test(server.getClientVersion()?.name || "") && candidate === FALLBACK_IDENTITY) return;
  if (process.env.CHAT_IDENTITY_FILE && candidate.startsWith("codex-startup:")) return;
  if (!/^(codex|claude|copilot):.+/.test(candidate)) {
    terminalAttachment("No resumable session ID available for MCP host " + JSON.stringify(server.getClientVersion()?.name || '') + ". Launch with the host's actual conversation identity; a PID or seat name cannot identify a conversation.");
    log(`ATTACHMENT REJECTED: ${attachmentError}`);
    return;
  }
  try {
    if (!db) db = openDb(CHAT_DB);
    claimConnection(
      db,
      candidate,
      "bridge",
      connection,
      Date.now(),
      candidate.startsWith("codex:") ? process.env.CHAT_IDENTITY_FILE || null : null
    );
    identity = candidate;
    conflicts = attachRooms(db, identity, connection, startupChat, process.env.SEAT);
    if (identity.startsWith('claude:')) {
      claudeDelivery = claudeHookConfig(CHAT_DB);
      attachClaudeRoute(db, identity, connection, claudeDelivery);
    }
    refreshMemberships();
    if (metadataIdentity && process.env.CHAT_DESKTOP_RELAY !== "0") {
      desktopRelay = new DesktopRelay({ db, identity, bridgeConnection: connection, log });
    }
    log(
      `attached identity="${identity}" connection="${connection}" rooms=${JSON.stringify([...joined.keys()])}`
    );
    for (const conflict of conflicts) log(`RESTORE CONFLICT: ${conflict}`);
    bridgeRetry.clear();
  } catch (error) {
    if (bridgeRetry.defer(error)) {
      // Retry the same connection claim; never take over another connection.
      identity = null;
      log("database busy during attachment; automatic retry scheduled");
      return;
    }
    terminalAttachment(error.message);
    if (identity) {
      try { detachConnection(db, identity, "bridge", connection); }
      catch (cleanupError) { log(`attachment cleanup deferred: ${cleanupError.message}`); }
    }
    identity = null;
    log(`ATTACHMENT REJECTED: ${attachmentError}`);
  }
}
var server = new Server(
  { name: "intercom", version: "0.5.6-dev.20261124" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: 'This is multi-session chat between Claude Code sessions over a shared store. Channel events are INCOMING messages from peers, formatted "[<chat>] <seat>: <text>". Default behavior is RELAY: show an incoming message to your user and reply only on their direction (autonomous back-and-forth only if the user explicitly says so). Tools: join({chat,seat?}) to enter a chat (seat auto-assigned if omitted); leave({chat}); chats() to list joined + available chats; send({chat?,body,to?}) to post a broadcast or address one live seat; (chat optional when in exactly one); history({chat?,limit?,before_id?}) for recent context; who({chat?}) for who is online. You may be in several chats at once.'
  }
);
var text = (t) => ({ content: [{ type: "text", text: t }] });
function resolveChat(arg) {
  if (arg) {
    if (!joined.has(arg)) throw new Error(`not joined to chat "${arg}" -- call join first`);
    return arg;
  }
  if (joined.size === 1) return [...joined.keys()][0];
  if (joined.size === 0) throw new Error("not in any chat -- call join({chat}) first");
  throw new Error(`in multiple chats (${[...joined.keys()].join(", ")}) -- pass chat explicitly`);
}
function doJoin(chat, seat) {
  const assigned = joinRoom(db, identity, connection, chat, seat);
  refreshMemberships();
  conflicts = conflicts.filter((message) => !message.startsWith(`Room ${chat}:`));
  log(`joined chat="${chat}" seat="${assigned}" identity="${identity}"`);
  const peers = listSeats(db, chat).filter((s) => s.seat !== assigned).map((s) => s.seat);
  return { assigned, peers, online: whoOnline(db, chat) };
}
var TOOLS = [
  {name:"listen",description:"Rearm this explicitly enrolled incoming listener; returns this actual session's routing proof only.",inputSchema:{type:"object",additionalProperties:false,properties:{}}},
  {name:"receive",description:"Read exactly one visible Intercom peer message by its durable message ID.",inputSchema:{type:"object",additionalProperties:false,properties:{message_id:{type:"integer",minimum:1}},required:["message_id"]}},
  {
    name: "delivery",
    description: "Inspect your directed Codex message, reserve an agent-assisted Desktop fallback when no owner is found, or report its result. Prepare only when you can use the normal Desktop send_message_to_thread tool. Never resend an uncertain message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["status", "prepare", "finish"] },
        message_id: { type: "integer", minimum: 1 },
        token: { type: "string" },
        outcome: { type: "string", enum: ["accepted", "not_sent", "uncertain"] },
        result: { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"], additionalProperties: false }
      },
      required: ["message_id"]
    }
  },
  {
    name: "join",
    description: "Join a chat (enter it and start receiving its messages). Seat auto-assigned if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string" },
        seat: { type: "string", description: "optional seat label; auto a-h if omitted" }
      },
      required: ["chat"]
    }
  },
  {
    name: "leave",
    description: "Leave a chat (stop receiving its messages, free your seat).",
    inputSchema: { type: "object", properties: { chat: { type: "string" } }, required: ["chat"] }
  },
  {
    name: "chats",
    description: "List chats you are in (with your seat) and all chats available to join.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "send",
    description: "Send a broadcast, or address one live seat with `to`. `chat` is optional when you are in exactly one chat.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string" },
        body: { type: "string" },
        to: {
          type: "string",
          description: "optional exact live seat name; only that session receives the message"
        }
      },
      required: ["body"]
    }
  },
  {
    name: "history",
    description: "Recent messages for catch-up. Page back with before_id.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string" },
        limit: { type: "number" },
        before_id: { type: "number" }
      }
    }
  },
  {
    name: "who",
    description: "Which seats are currently online in a chat.",
    inputSchema: { type: "object", properties: { chat: { type: "string" } } }
  },
  {
    name: "rename",
    description: "Rename a chat. All members pick up the new name automatically.",
    inputSchema: {
      type: "object",
      properties: { chat: { type: "string" }, to: { type: "string" } },
      required: ["to"]
    }
  }
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await initializeProject();
  let supplied = null;
  if (/codex/i.test(server.getClientVersion()?.name || "")) {
    const thread = codexThreadId(req.params._meta);
    supplied = thread ? `codex:${thread}` : null;
    if (metadataIdentity && supplied !== metadataIdentity)
      throw new Error("Missing or different task metadata on a bound Intercom connection; reconnect this task.");
    if (supplied && identity && supplied !== identity)
      throw new Error("Codex task metadata does not match the Intercom launcher identity; refusing cross-session access.");
    if (supplied && !identity && !process.env.CHAT_IDENTITY_FILE && !process.env.CHAT_IDENTITY)
      metadataIdentity = supplied;
  }
  activateIdentity();
  if (supplied && identity && supplied !== identity)
    throw new Error("Codex task metadata does not match the Intercom launcher identity; refusing cross-session access.");
  if (attachmentError) throw new Error(attachmentError);
  if (!identity && bridgeRetry.failures) throw new Error("Intercom database busy; attachment will retry automatically.");
  if (identity) {
    try { bridgeFence(); }
    catch (error) { bridgeDatabaseError(error); throw error; }
  }
  if (!identity)
    throw new Error("Waiting for the actual Codex thread ID; retry after the relay attaches, or use a Desktop executor that supplies task metadata.");
  if (req.params.name === "delivery") {
    const result = await nativeHandoff({ db, sender: identity, connection, args: req.params.arguments || {}, enabled: process.env.CHAT_DESKTOP_RELAY !== "0" });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  return atomic(db, () => {
    renewConnection(db, identity, "bridge", connection);
    refreshMemberships();
    const a = req.params.arguments || {};
    switch (req.params.name) {
      case "listen": {
        if (identity.startsWith('claude:')) {
          const config = claudeHookConfig(CHAT_DB);
          const active = config && claudeDelivery && config.generation === claudeDelivery.generation && claudeHookRoute(db, identity, config);
          if (!active || active.connection_id !== connection) throw Error('No explicitly selected Claude hook route to rearm');
          const proof = {reader_identity:identity,generation:config.generation,connection_id:connection};
          return {content:[{type:'text',text:JSON.stringify({intercom_listen:proof})}],structuredContent:{intercom_listen:proof}};
        }
        if(!identity.startsWith('codex:'))throw Error('Listen requires an enrolled Codex thread');
        const config=deliveryConfig(identity.slice(6)),active=busyTurnRecord(db,identity);
        if(!config||config.busyHooks!==true||active?.generation!==config.generation)throw Error('No active enrolled Intercom turn to rearm');
        return {content:[{type:'text',text:'Intercom renewal metadata is ready for the current turn hook to verify.'}],structuredContent:{intercom_listen:{reader_identity:identity,turn_id:active.turn_id,generation:config.generation}}};
      }
      case "receive": {
        const row = receivedRow(db, identity, a.message_id);
        const proof = identity.startsWith('claude:') ? claudeReceiveProof(db, identity, connection, claudeDelivery, row) : {};
        const metadata = {reader_identity:identity,message_id:row.id,...proof};
        return {content:[{type:"text",text:peerPrompt(row.chat,row)},...proof.claude_hook ? [{type:'text',text:JSON.stringify({intercom_receive:metadata})}] : []],structuredContent:{intercom_receive:metadata}};
      }
      case "join": {
        const r = doJoin(a.chat, a.seat);
        const suffixed = a.seat && r.assigned !== a.seat;
        return text(
          `Joined "${a.chat}" as seat "${r.assigned}". ` + (suffixed ? `(Requested "${a.seat}" but a live session holds it, so you are "${r.assigned}".) ` : "") + (r.peers.length ? `Other seats: ${r.peers.join(", ")}. ` : "No other seats yet. ") + (r.online.length ? `Online now: ${r.online.join(", ")}.` : "")
        );
      }
      case "leave": {
        const chat = a.chat || resolveChat();
        leaveRoom(db, identity, connection, chat);
        joined.delete(chat);
        conflicts = conflicts.filter((message) => !message.startsWith(`Room ${chat}:`));
        log(`left chat="${chat}"`);
        return text(`Left "${chat}".`);
      }
      case "chats": {
        const mine = [...joined.entries()].map(([c, v]) => `${c} (seat ${v.seat})`);
        const all = knownChats(db);
        return text(
          `You are in: ${mine.length ? mine.join(", ") : "(none)"}
Available chats: ${all.length ? all.join(", ") : "(none)"}
Identity: ${identity}
` + (identity.startsWith('claude:') ? (claudeDelivery ? 'Delivery: explicitly selected Claude hooks; host admission and live receipt remain to be verified. Native channel emission is disabled for this attachment.\n' : 'Delivery: Claude native channel; host channel admission is required.\n') : '') + (identity.startsWith('copilot:') ? (server.getClientVersion()?.name==='copilot-intercom' ? 'Delivery: Copilot SDK extension.\n' : 'Delivery: MCP pull-only; call history to read incoming messages. No automatic wake-up.\n') : '') + (projectWarning ? `${projectWarning}
` : "") + (metadataIdentity ? desktopRelay ? `Delivery: Desktop IPC relay \u2014 ${desktopRelay.state}
` : "Delivery: MCP pull-only; Desktop relay disabled.\n" : "") + `Saved rooms: ${subscriptions(db, identity).map((s) => `${s.chat} (${s.seat})`).join(", ") || "(none)"}
` + (conflicts.length ? `Restore conflicts:
${conflicts.join("\n")}` : "") + db.prepare(
            `SELECT message_id,chat,state FROM delivery_receipts
          WHERE identity=? AND state IN ('submitting','uncertain')`
          ).all(identity).map((r) => {
            const s = deliveryStatus(db, identity, r.message_id);
            return `
${s.needsReconciliation ? "Delivery needs reconciliation" : "Delivery in progress"}: #${r.message_id} in ${r.chat} (${s.status})`;
          }).join("")
        );
      }
      case "send": {
        const chat = resolveChat(a.chat);
        if (typeof a.body !== "string" || !a.body.trim())
          throw new Error("send requires a non-empty body");
        const { seat } = joined.get(chat);
        const targetName = typeof a.to === "string" ? a.to.trim() : "";
        let target = null;
        if (targetName) {
          target = listSeats(db, chat).find((candidate) => candidate.seat === targetName);
          if (target && !whoOnline(db, chat, 30).includes(target.seat)) target = null;
          if (!target) {
            const available = listSeats(db, chat).map((candidate) => candidate.seat);
            throw new Error(
              `seat "${targetName}" is not currently in "${chat}"` + (available.length ? `; available seats: ${available.join(", ")}` : "; no seats are present")
            );
          }
          if (target.identity === identity)
            throw new Error("cannot send a direct message to your own seat");
        }
        const id = sendMessage(db, chat, seat, a.body.trim(), {
          senderIdentity: identity,
          toSeat: target?.seat ?? null,
          toIdentity: target?.identity ?? null
        });
        log(`sent chat="${chat}" seat="${seat}" to="${target?.seat ?? "*"}" id=${id}`);
        const sent = text(
          target ? `Sent directly to "${target.seat}" in "${chat}" as "${seat}" (id ${id}).` : `Broadcast to "${chat}" as "${seat}" (id ${id}).`
        );
        sent.structuredContent = { message_id: id, chat, recipient_identity: target?.identity || null };
        if (identity.startsWith("codex:") && target?.identity?.startsWith("codex:"))
          sent.content[0].text += ' If your normal Desktop send_message_to_thread tool is available, call delivery({action:"prepare",message_id:' + id + '}) to check whether a native fallback is needed. Only forward when it returns status "reserved", then report its result with delivery({action:"finish",...}).';
        return sent;
      }
      case "history": {
        const chat = resolveChat(a.chat);
        const rows = history(db, chat, {
          limit: a.limit ?? 30,
          beforeId: a.before_id,
          viewerIdentity: identity
        });
        if (!rows.length) return text(`No history in "${chat}".`);
        return text(
          rows.map((r) => {
            const route = r.to_seat ? `${r.seat} -> ${r.to_seat}` : r.seat;
            return `#${r.id} ${route}: ${r.body ?? r.summary ?? r.ref ?? ""}`;
          }).join("\n")
        );
      }
      case "who": {
        const chat = resolveChat(a.chat);
        const on = whoOnline(db, chat);
        return text(
          on.length ? `Online in "${chat}": ${on.join(", ")}` : `Nobody online in "${chat}".`
        );
      }
      case "rename": {
        const chat = resolveChat(a.chat);
        const to = (a.to || "").trim();
        if (!to || /[^a-zA-Z0-9._-]/.test(to))
          throw new Error("rename target must use only a-z A-Z 0-9 . _ -");
        if (to === chat) return text(`Chat is already named "${chat}".`);
        const state = joined.get(chat);
        migrateChat(db, chat, to);
        joined.delete(chat);
        joined.set(to, state);
        setCursor(db, to, state.seat, state.cursor);
        sendMessage(db, to, state.seat, `(renamed this chat from "${chat}" to "${to}")`, {
          senderIdentity: identity
        });
        log(`renamed "${chat}" -> "${to}"`);
        return text(`Renamed "${chat}" to "${to}". Other members will pick it up automatically.`);
      }
      default:
        throw new Error(`unknown tool: ${req.params.name}`);
    }
  });
});
await server.connect(new StdioServerTransport());
log(`connected (awaiting host identity, db=${CHAT_DB})`);
function projectChat() {
  const raw = process.env.CHAT_PROJECT || basename(process.cwd());
  return (raw || "project").replace(/[^a-zA-Z0-9._-]/g, "-");
}
var startupChat = process.env.CHAT || null;
if (!startupChat && /^(1|true|yes|on)$/i.test(process.env.CHAT_AUTOJOIN_PROJECT ?? "1")) {
  startupChat = projectChat();
}
activateIdentity();
setInterval(() => {
  void initializeProject().then(activateIdentity).catch((error) => log(error.message));
}, 250);
setInterval(() => {
  void desktopRelay?.tick();
}, 1200);
var POLL_MS = 1500;
var polling = false;
setInterval(async () => {
  if (!identity || polling || attachmentError || !bridgeRetry.ready()) return;
  polling = true;
  try {
    bridgeFence();
    refreshMemberships();
    if (!identity.startsWith("claude:") || claudeDelivery) return;
    for (const [chat, state] of joined) {
      try {
        const rows = messagesAfter(db, chat, state.seat, state.cursor, { identity: state.identity });
        for (const row of rows) {
          await server.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${chat}] ${row.seat}${row.to_seat ? ` -> ${row.to_seat}` : ""}: ${row.body}`,
              // meta values MUST be strings (see HARD RULES above).
              meta: {
                chat: String(chat),
                seat: String(row.seat),
                id: String(row.id),
                direct: String(Boolean(row.to_identity)),
                to: String(row.to_seat || "")
              }
            }
          });
          atomic(db, () => {
            renewConnection(db, identity, "bridge", connection);
            if (!liveMemberships(db, identity, connection).some(
              (r) => r.chat === chat && r.seat === state.seat
            ))
              return;
            if (row.id > state.cursor) {
              state.cursor = row.id;
              setCursor(db, chat, state.seat, row.id);
              setDeliveryCursor(db, chat, identity, "claude-channel", row.id);
            }
          });
        }
      } catch (err) {
        log(`poll error chat="${chat}": ${err}`);
      }
    }
  } catch (error) {
    bridgeDatabaseError(error);
  } finally {
    polling = false;
  }
}, POLL_MS);
setInterval(() => {
  if (!identity || attachmentError || !bridgeRetry.ready()) return;
  try { bridgeFence(); }
  catch (error) { bridgeDatabaseError(error); }
}, 5e3);
log(`loops started (poll=${POLL_MS}ms)`);
function shutdown() {
  desktopRelay?.stop();
  if (identity && claudeDelivery) try { closeClaudeRoute(db, identity, connection); } catch {}
  if (identity)
    try {
      detachConnection(db, identity, "bridge", connection);
    } catch {
    }
  process.exit(0);
}
server.onclose = shutdown;
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
