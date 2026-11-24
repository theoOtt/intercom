import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDb,history,messagesAfter,sendMessage} from './chat-db.mjs';
const dir=mkdtempSync(join(tmpdir(),'intercom-visibility-')),db=openDb(join(dir,'chat.db'));
try {
 const viewer='codex:'+randomUUID(),sender='claude:'+randomUUID();
 const hidden=sendMessage(db,'fixture','Peer','unknown direct owner',{senderIdentity:sender,toIdentity:'codex:'+randomUUID(),toSeat:'Old seat'});
 db.prepare('UPDATE messages SET to_identity=NULL WHERE id=?').run(hidden);
 const shown=sendMessage(db,'fixture','Peer','broadcast',{senderIdentity:sender});
 assert.deepEqual(messagesAfter(db,'fixture','Viewer',0,{identity:viewer}).map(r=>r.id),[shown]);
 assert.deepEqual(history(db,'fixture',{viewerIdentity:viewer}).map(r=>r.id),[shown]);
 assert(history(db,'fixture',{viewerIdentity:sender}).some(r=>r.id===hidden));
 assert(history(db,'fixture').some(r=>r.id===hidden));
 console.log('PASS: unknown direct ownership stays private in live and history consumers; sender and explicit administrative inspection retain access');
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
