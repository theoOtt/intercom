import {readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// Positive evidence only. Missing, compressed, incomplete or inaccessible logs
// never authorize resubmission or advancement of a cursor.
export class TranscriptProof {
  constructor(root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')) {
    this.root = root;
    this.files = new Map();
    this.nextList = 0;
  }
  find(threadId, messageId, prompt, sentAt) {
    if (!uuid.test(threadId) || !Number.isFinite(Date.parse(sentAt))) return null;
    const key = `${threadId}:${messageId}:${prompt}`;
    if (this.key !== key) {
      this.key = key; this.files.clear(); this.nextList = 0; this.proof = null;
    }
    if (this.proof) return this.proof;
    if (Date.now() >= this.nextList) {
      this.nextList = Date.now() + 30000;
      const visit = (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path, depth + 1);
          else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl') && !this.files.has(path))
            this.files.set(path, {offset: 0, tail: Buffer.alloc(0), dropping: false});
        }
      };
      try {
        const root = lstatSync(this.root);
        if (root.isDirectory() && !root.isSymbolicLink()) visit(this.root, 0);
      } catch { return null; }
    }
    let budget = 4 * 1024 * 1024;
    for (const [path, state] of this.files) {
      let fd;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid()) continue;
        if (state.ino !== stat.ino || stat.size < state.offset) {
          state.ino = stat.ino; state.offset = 0; state.tail = Buffer.alloc(0); state.dropping = false;
        }
        while (budget > 0 && state.offset < stat.size) {
          const chunk = Buffer.alloc(Math.min(256 * 1024, budget, stat.size - state.offset));
          const size = readSync(fd, chunk, 0, chunk.length, state.offset);
          if (!size) break;
          state.offset += size; budget -= size;
          let data = Buffer.concat([state.tail, chunk.subarray(0, size)]), start = 0, end;
          while ((end = data.indexOf(10, start)) >= 0) {
            const line = data.subarray(start, end); start = end + 1;
            if (state.dropping) { state.dropping = false; continue; }
            if (!line.includes(Buffer.from('"UserMessage"'))) continue;
            try {
              const record = JSON.parse(line.toString('utf8')), p = record.payload, item = p?.item;
              if (record.type !== 'event_msg' || p?.type !== 'item_completed' ||
                  p.thread_id !== threadId || !uuid.test(p.turn_id || '') ||
                  item?.type !== 'UserMessage' || typeof item.id !== 'string' ||
                  !Number.isFinite(Date.parse(record.timestamp)) ||
                  Date.parse(record.timestamp) < Date.parse(sentAt)) continue;
              if (item.content?.length !== 1 || item.content[0].type !== 'text' ||
                  item.content[0].text !== prompt) continue;
              this.proof = {turnId: p.turn_id, itemId: item.id, timestamp: record.timestamp, path};
              return this.proof;
            } catch { /* Incomplete evidence remains quarantined. */ }
          }
          state.tail = data.subarray(start);
          if (state.tail.length > 16 * 1024 * 1024) { state.tail = Buffer.alloc(0); state.dropping = true; }
        }
      } catch { /* Read failures cannot turn uncertainty into acceptance. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      if (budget <= 0) break;
    }
    return null;
  }
}
