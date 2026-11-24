// ../codex/desktop-ipc.mjs
import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
var desktopSocket = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "ipc", "ipc.sock");
var UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var IpcError = class extends Error {
  constructor(message, notSubmitted = false) {
    super(message);
    this.notSubmitted = notSubmitted;
  }
};
var DesktopIpc = class {
  constructor({ socketPath = desktopSocket(), timeoutMs = 12e3 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }
  async connect() {
    if (process.platform === "win32") throw new IpcError("Desktop IPC adapter currently supports Unix sockets only", true);
    for (const [path, isSocket] of [[dirname(this.socketPath), false], [this.socketPath, true]]) {
      const s = lstatSync(path);
      if (s.uid !== process.getuid() || s.mode & 63 || !(isSocket ? s.isSocket() : s.isDirectory()))
        throw new IpcError("Unsafe Desktop IPC ownership/permissions", true);
    }
    this.pending = /* @__PURE__ */ new Map();
    this.buffer = Buffer.alloc(0);
    this.clientId = "initializing-client";
    this.socket = createConnection(this.socketPath);
    this.socket.on("error", (e) => this.fail(e));
    this.socket.on("close", () => this.fail(new Error("Desktop IPC disconnected")));
    this.socket.on("data", (chunk) => this.receive(chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new IpcError("Desktop IPC connect timed out", true));
      }, this.timeoutMs);
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (e) => {
        clearTimeout(timer);
        const refused = e.code === "ECONNREFUSED" && e.syscall === "connect" && (e.address || e.path) === this.socketPath && this.socketPath === desktopSocket();
        if (refused) e.intercomLegacySocketRefused = true;
        reject(e);
      });
    });
    const r = await this.request("initialize", { clientType: "intercom" }, 0);
    if (!UUID.test(r.result?.clientId || "")) throw new IpcError("Unsupported Desktop IPC initialization", true);
    this.clientId = r.result.clientId;
  }
  fail(error) {
    for (const p of this.pending?.values() || []) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending?.clear();
  }
  close() {
    this.socket?.destroy();
  }
  write(message) {
    if (!this.socket?.writable) throw new Error("Desktop IPC is not connected");
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    if (body.length > 8 * 1024 * 1024) throw new IpcError("Intercom message exceeds IPC frame limit", true);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const n = this.buffer.readUInt32LE(0);
        if (!n || n > 8 * 1024 * 1024) throw new Error("Unsupported/oversized Desktop IPC frame");
        if (this.buffer.length < n + 4) return;
        const m = JSON.parse(this.buffer.subarray(4, n + 4).toString());
        this.buffer = this.buffer.subarray(n + 4);
        if (m.type === "client-discovery-request")
          this.write({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } });
        if (m.type !== "response") continue;
        const p = this.pending.get(m.requestId);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(m.requestId);
        if (m.resultType !== "success") {
          p.reject(new IpcError(
            m.error || "Desktop IPC rejected request",
            ["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(m.error)
          ));
        } else if (m.method !== p.method || p.target && m.handledByClientId !== p.target) {
          p.reject(new Error("Unexpected Desktop response owner/method; delivery uncertain"));
        } else p.resolve(m);
      }
    } catch (error) {
      this.fail(error);
      this.close();
    }
  }
  request(method, params, version2, target) {
    if (!["initialize", "thread-owner-discovery", "thread-follower-steer-turn", "thread-follower-start-turn"].includes(method))
      throw new IpcError("Intercom does not support this IPC operation", true);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out; outcome uncertain`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method, target });
      try {
        this.write({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version: version2,
          method,
          params,
          targetClientId: target,
          timeoutMs: this.timeoutMs - 500
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  async findOwner(threadId) {
    if (!UUID.test(threadId)) throw new IpcError("A real task UUID is required", true);
    try {
      await this.connect();
      const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, 1);
      if (!UUID.test(owner.handledByClientId || "")) throw new IpcError("No task owner returned", true);
      return owner.handledByClientId;
    } finally {
      this.close();
    }
  }
  async deliver(threadId, prompt, beforeSubmit, onNotSubmitted = () => {
  }) {
    if (!UUID.test(threadId)) throw new IpcError("A real task UUID is required", true);
    try {
      try {
        await this.connect();
        const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, 1);
        if (!UUID.test(owner.handledByClientId || "")) throw new Error("No task owner returned");
        this.owner = owner.handledByClientId;
      } catch (e) {
        const error = new IpcError(e.message, true);
        error.intercomLegacySocketRefused = e.intercomLegacySocketRefused === true;
        throw error;
      }
      const input = [{ type: "text", text: prompt, text_elements: [] }];
      const guard = () => {
        try {
          if (!beforeSubmit()) throw new IpcError("Room left or connection retired before delivery", true);
        } catch (error) {
          error.notSubmitted = true;
          throw error;
        }
      };
      guard();
      let method = "thread-follower-steer-turn", response;
      try {
        response = await this.request(method, {
          conversationId: threadId,
          input,
          attachments: [],
          clientUserMessageId: randomUUID(),
          restoreMessage: {
            id: randomUUID(),
            text: prompt,
            createdAt: Date.now(),
            context: { prompt, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null }
          }
        }, 1, this.owner);
      } catch (e) {
        if (e.message !== `Cannot steer conversation ${threadId} because its active turn already ended`) throw e;
        try {
          onNotSubmitted();
        } catch (error) {
          error.notSubmitted = true;
          throw error;
        }
        guard();
        method = "thread-follower-start-turn";
        response = await this.request(method, { conversationId: threadId, turnStart: { request: { threadId, input } } }, 2, this.owner);
      }
      const result = response.result?.result;
      const turnId = result?.turnId || result?.turn?.id;
      if (!turnId) throw new Error("Desktop returned no accepted turn ID; delivery uncertain");
      return { turnId, method };
    } finally {
      this.close();
    }
  }
};
export {
  DesktopIpc,
  IpcError
};
