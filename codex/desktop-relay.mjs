import {randomUUID as randomUUID4} from 'node:crypto';
import {DesktopIpc} from './desktop-ipc.mjs';
import {TranscriptProof} from './transcript-proof.mjs';
import {atomic,claimConnection,assertConnection,renewConnection,detachConnection,liveMemberships} from '../bridge/session-store.mjs';
import {messagesAfter,getDeliveryCursor} from '../bridge/chat-db.mjs';
import {receiptFor,attemptFor,blockedReceipt,deliveryStatus,advanceCursor,eligible,putAttempt,setReceipt,ownsAttempt} from '../bridge/delivery-state.mjs';
import {peerPrompt} from '../bridge/peer-envelope.mjs';
import {SqliteRetry,recoverOwnedConnections} from '../bridge/sqlite-recovery.mjs';
import {loadDesktopQueue} from './desktop-queue.mjs';
import {activeBusyTurn,deliveryNotice,incomingVisible,deliveryConfig} from './delivery-core.mjs';
var DesktopRelay = class {
  constructor({ db, identity, bridgeConnection, client = new DesktopIpc(), log = () => {}, retry = new SqliteRetry(), queueFallback = undefined }) {
    this.db = db; this.identity = identity; this.bridgeConnection = bridgeConnection;
    this.client = client; this.log = log; this.retry = retry;
    this.queueFallback = queueFallback; // Default disabled; no queue process is launched.
    this.connection = randomUUID4(); this.consumer = 'codex-app-server';
    this.state = 'waiting for a message / Desktop owner';
    this.stopped = false; this.busy = false; this.pendingOutcome = null;
    this.transcriptProof = new TranscriptProof();
    claimConnection(db, identity, 'relay', this.connection, Date.now(), null);
    this.heartbeat = setInterval(() => this.heartbeatTick(), 5000);
    this.heartbeat.unref();
  }
  fence() {
    if (this.stopped) throw new Error('Desktop relay stopped');
    if (this.retry.failures) {
      recoverOwnedConnections(this.db, this.identity, [
        ['bridge', this.bridgeConnection], ['relay', this.connection]
      ]);
    }
    assertConnection(this.db, this.identity, 'bridge', this.bridgeConnection);
    renewConnection(this.db, this.identity, 'relay', this.connection);
  }
  handleError(error) {
    if (this.retry.defer(error)) {
      this.state = `database busy; automatic retry scheduled${this.pendingOutcome ? '; saving delivery outcome without resending' : ''}`;
      this.log(this.state);
      return;
    }
    this.state = error.message; this.log(error.message); this.stop();
  }
  heartbeatTick() {
    if (this.stopped || !this.retry.ready()) return;
    try {
      this.fence();
      // Retain retry state until any pending outcome has also been persisted.
      if (!this.pendingOutcome) this.retry.clear();
    } catch (error) { this.handleError(error); }
  }
  stop() {
    clearInterval(this.heartbeat);
    this.stopped = true; this.client.close();
    try { detachConnection(this.db, this.identity, 'relay', this.connection); }
    catch (error) { this.log(`relay cleanup deferred to lease expiry: ${error.message}`); }
  }
  persistOutcome() {
    const outcome = this.pendingOutcome;
    if (!outcome) return;
    const { row, chat, attemptId, state, result, detail } = outcome;
    atomic(this.db, () => {
      this.fence();
      if (!ownsAttempt(this.db, this.identity, row.id, attemptId))
        throw new Error(`Delivery attempt ownership changed for #${row.id}; reconcile without resending`);
      const currentChat = this.db.prepare('SELECT chat FROM messages WHERE id=?').get(row.id)?.chat || chat;
      setReceipt(this.db, this.identity, row.id, currentChat, state, detail, result?.turnId || null);
      if (state === 'accepted') advanceCursor(this.db, currentChat, this.identity, row.id);
      this.db.prepare('UPDATE delivery_attempts SET phase=? WHERE identity=? AND message_id=?')
        .run(state === 'accepted' ? 'done' : 'failed', this.identity, row.id);
    });
    this.pendingOutcome = null;
    this.state = state === 'accepted' ? `connected; #${row.id} accepted via ${result.method}` : `${state}: #${row.id} ${detail}`;
  }
  async tick() {
    if (this.stopped || this.busy || !this.retry.ready()) return;
    this.busy = true;
    try {
      this.fence();
      if (this.pendingOutcome) {
        this.persistOutcome(); this.retry.clear(); return;
      }
      const hookTurn = activeBusyTurn(this.db, this.identity);
      if (hookTurn) { this.state = `active turn ${hookTurn.turn_id} reserved for trusted notification hook; idle queue deferred`; this.retry.clear(); return; }
      let pending;
      for (const membership of liveMemberships(this.db, this.identity, this.bridgeConnection)) {
        const cursor = getDeliveryCursor(this.db, membership.chat, this.identity, this.consumer);
        if (cursor === null) continue;
        const row = messagesAfter(this.db, membership.chat, membership.seat, cursor, { identity: this.identity }).find(candidate => incomingVisible(candidate, this.identity, membership.seat));
        if (row && (!pending || row.id < pending.row.id)) pending = { chat: membership.chat, row };
      }
      if (!pending) {
        if (this.retry.failures) this.state = 'database recovered; waiting for a message / Desktop owner';
        this.retry.clear(); return;
      }
      const { chat, row } = pending;
      const receipt = receiptFor(this.db, this.identity, row.id);
      if (receipt?.state === 'accepted') {
        advanceCursor(this.db, chat, this.identity, row.id); this.retry.clear(); return;
      }
      if (receipt?.state === 'uncertain') {
        const proof = this.transcriptProof.find(this.identity.slice(6), row.id, peerPrompt(chat, row), row.ts);
        if (proof) {
          atomic(this.db, () => {
            this.fence();
            const current = receiptFor(this.db, this.identity, row.id);
            if (current?.state !== 'uncertain' || current.updated_at !== receipt.updated_at) return;
            setReceipt(this.db, this.identity, row.id, chat, 'accepted',
              `Exact incoming delivery verified in recipient transcript; item=${proof.itemId}; no resend`, proof.turnId);
            this.db.prepare("UPDATE delivery_attempts SET phase='done' WHERE identity=? AND message_id=?")
              .run(this.identity, row.id);
            advanceCursor(this.db, chat, this.identity, row.id);
          });
          this.state = `connected; #${row.id} reconciled from recipient transcript without resending`;
          this.retry.clear(); return;
        }
      }
      if (blockedReceipt(receipt)) {
        this.state = `#${row.id}: ${deliveryStatus(this.db, this.identity, row.id).status}; later messages are waiting`;
        this.retry.clear(); return;
      }
      const route = deliveryConfig(this.identity.slice(6));
      if (route && row.id <= route.afterMessageId) {
        this.state = `#${row.id} predates this automatic delivery cutover; retained without replay`;
        this.retry.clear(); return;
      }
      const attemptId = randomUUID4();
      atomic(this.db, () => {
        this.fence();
        const current = receiptFor(this.db, this.identity, row.id);
        if (blockedReceipt(current) || current?.state === 'accepted' || !eligible(this.db, this.identity, chat, row.id)) return;
        putAttempt(this.db, { identity: this.identity, id: row.id, attemptId, mode: 'ipc', phase: 'discovering',
          ownerIdentity: this.identity, ownerRole: 'relay', ownerConnection: this.connection });
        setReceipt(this.db, this.identity, row.id, chat, 'pending', 'looking for Desktop owner; not submitted');
      });
      if (!ownsAttempt(this.db, this.identity, row.id, attemptId)) return;
      this.retry.clear();
      this.state = `looking for Desktop owner for #${row.id}`;
      // Only deliver() performs an external submission. Persistence is outside
      // this try/catch: a failed SQLite commit cannot erase an accepted response.
      try {
        const result = await this.client.deliver(this.identity.slice(6), peerPrompt(chat, row), () => atomic(this.db, () => {
          this.fence();
          if (activeBusyTurn(this.db, this.identity) || !ownsAttempt(this.db, this.identity, row.id, attemptId) || !eligible(this.db, this.identity, chat, row.id)) return false;
          this.db.prepare("UPDATE delivery_attempts SET phase='ipc_sending' WHERE identity=? AND message_id=?").run(this.identity, row.id);
          setReceipt(this.db, this.identity, row.id, chat, 'submitting', 'IPC submission in flight');
          this.state = `sending #${row.id}`;
          return true;
        }), () => atomic(this.db, () => {
          this.fence();
          if (!ownsAttempt(this.db, this.identity, row.id, attemptId)) return;
          this.db.prepare("UPDATE delivery_attempts SET phase='discovering' WHERE identity=? AND message_id=?").run(this.identity, row.id);
          setReceipt(this.db, this.identity, row.id, chat, 'pending', 'steer rejected before submission; preparing idle delivery');
        }));
        this.pendingOutcome = { row, chat, attemptId, state: 'accepted', result,
          detail: `${result.method} accepted; reading not independently confirmed` };
      } catch (error) {
        // An available IPC owner, native reservation, timeout, malformed IPC
        // response, permission failure or unknown submission never falls back.
        let q;
        try { q = this.queueFallback === undefined ? loadDesktopQueue(this.identity.slice(6)) : this.queueFallback; }
        catch (scopeError) { this.log(`Queue fallback unavailable: ${scopeError.message}`); q = null; }
        const scoped = q && q.threadId === this.identity.slice(6) &&
          Number.isSafeInteger(row.id) && row.id < Number.MAX_SAFE_INTEGER &&
          row.sender_identity !== this.identity && (row.to_identity === null || row.to_identity === this.identity) &&
          Number.isSafeInteger(q.afterMessageId) && q.afterMessageId >= 0 && row.id > q.afterMessageId;
        if (scoped && error.notSubmitted === true && error.intercomLegacySocketRefused === true) {
          // Queue adapter contract: validate the trusted existing Desktop target
          // before guard(); never start/resume an engine; invoke once after guard;
          // return {queued:true,threadId}. Any post-guard error is quarantined.
          let invoked = false;
          try {
            const queued = await q.deliver(this.identity.slice(6), deliveryNotice(row.id), () => atomic(this.db, () => {
              this.fence();
              if (activeBusyTurn(this.db, this.identity) || !ownsAttempt(this.db, this.identity, row.id, attemptId) || !eligible(this.db, this.identity, chat, row.id)) return false;
              const a = attemptFor(this.db, this.identity, row.id);
              const current = receiptFor(this.db, this.identity, row.id);
              if (a?.mode !== 'ipc' || a?.phase !== 'discovering' || current?.state !== 'pending') return false;
              this.db.prepare("UPDATE delivery_attempts SET mode='queue',phase='queue_sending' WHERE identity=? AND message_id=?").run(this.identity, row.id);
              setReceipt(this.db, this.identity, row.id, chat, 'submitting', 'durable queue submission in flight; no automatic retry');
              invoked = true;
              return true;
            }));
            if (!invoked || queued?.queued !== true || queued.threadId !== this.identity.slice(6))
              throw new Error('Queue adapter returned no exact-target acceptance');
            this.pendingOutcome = { row, chat, attemptId, state: 'accepted', result: {method:'thread/queue/add'},
              detail: 'Durable queue accepted; engine consumption and model reading not independently confirmed' };
          } catch (queueError) {
            this.pendingOutcome = { row, chat, attemptId, state: invoked && queueError.intercomQueueNeverSpawned !== true ? 'uncertain' : 'pending',
              detail: `Queue ${invoked && queueError.intercomQueueNeverSpawned !== true ? 'outcome unknown; do not resend' : 'not invoked'}: ${queueError.message}` };
          }
        } else {
          this.pendingOutcome = { row, chat, attemptId, state: error.notSubmitted ? 'pending' : 'uncertain', detail: error.message };
        }
      }
      this.persistOutcome();
      this.retry.clear();
    } catch (error) { this.handleError(error); }
    finally { this.busy = false; }
  }
};

export {DesktopRelay};
