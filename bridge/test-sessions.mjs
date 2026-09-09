import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  openDb,
  messagesAfter,
  sendMessage,
  setDeliveryCursor,
  getDeliveryCursor,
  migrateChat,
  history,
} from './chat-db.mjs'
import {
  claimConnection,
  assertConnection,
  renewConnection,
  detachConnection,
  attachRooms,
  joinRoom,
  leaveRoom,
  subscriptions,
  liveMemberships,
  LEASE_MS,
} from './session-store.mjs'

const temp = mkdtempSync(join(tmpdir(), 'intercom-sessions-'))
const path = join(temp, 'chat.db')
const db = openDb(path)
const a = 'codex:original-thread'
const b = 'codex:other-thread'
const check = (name, fn) => {
  fn()
  console.log(`PASS: ${name}`)
}
try {
  claimConnection(db, a, 'bridge', 'first')
  attachRooms(db, a, 'first', 'project', 'Builder')
  joinRoom(db, a, 'first', 'review', 'Reviewer')
  setDeliveryCursor(db, 'review', a, 'codex-app-server', 0)
  const unread = sendMessage(db, 'review', 'peer', 'unread direct', {
    senderIdentity: b,
    toIdentity: a,
    toSeat: 'Reviewer',
  })
  check('duplicate live identity rejected', () => {
    assert.throws(() => claimConnection(db, a, 'bridge', 'duplicate'), /already has a live/)
    assert.equal(liveMemberships(db, a, 'first').length, 2)
  })
  detachConnection(db, a, 'bridge', 'first')
  check('disconnect preserves subscriptions and identity cursors', () => {
    assert.equal(subscriptions(db, a).length, 2)
    assert.equal(getDeliveryCursor(db, 'review', a, 'codex-app-server'), 0)
  })
  claimConnection(db, a, 'bridge', 'resumed')
  attachRooms(db, a, 'resumed', 'different-directory', 'wrong-name')
  check('resume restores exact room names and seats regardless of cwd', () => {
    assert.deepEqual(
      liveMemberships(db, a, 'resumed').map((r) => [r.chat, r.seat]),
      [
        ['project', 'Builder'],
        ['review', 'Reviewer'],
      ]
    )
    assert.equal(messagesAfter(db, 'review', 'Reviewer', 0, { identity: a })[0].id, unread)
  })
  claimConnection(db, b, 'bridge', 'other')
  attachRooms(db, b, 'other', 'project', 'Builder')
  check('same project cannot make a new session impersonate another', () => {
    assert.equal(liveMemberships(db, b, 'other')[0].seat, 'Builder-2')
    assert.deepEqual(
      subscriptions(db, b).map((r) => r.chat),
      ['project']
    )
    assert.equal(history(db, 'review', { viewerIdentity: b }).length, 1) // sender owns its message
    assert.equal(history(db, 'review', { viewerIdentity: 'codex:fork' }).length, 0)
  })
  joinRoom(db, a, 'resumed', 'review', 'New-Reviewer')
  check('seat changes preserve unread direct ownership and avoid self echoes', () => {
    assert.equal(messagesAfter(db, 'review', 'New-Reviewer', 0, { identity: a })[0].id, unread)
    sendMessage(db, 'review', 'Reviewer', 'old self message', { senderIdentity: a })
    assert.equal(messagesAfter(db, 'review', 'New-Reviewer', unread, { identity: a }).length, 0)
  })
  migrateChat(db, 'review', 'reviews-renamed')
  detachConnection(db, a, 'bridge', 'resumed')
  // Another identity takes the label while the owner is offline.
  joinRoom(db, b, 'other', 'reviews-renamed', 'New-Reviewer')
  claimConnection(db, a, 'bridge', 'conflicted')
  const conflicts = attachRooms(db, a, 'conflicted', 'project', 'unwanted')
  check('occupied saved seat is reported without takeover or automatic rename', () => {
    assert.equal(conflicts.length, 1)
    assert.equal(
      subscriptions(db, a).find((r) => r.chat === 'reviews-renamed').seat,
      'New-Reviewer'
    )
    assert.equal(liveMemberships(db, a, 'conflicted').length, 1)
    assert.equal(
      liveMemberships(db, b, 'other').find((r) => r.chat === 'reviews-renamed').seat,
      'New-Reviewer'
    )
  })
  leaveRoom(db, a, 'conflicted', 'project')
  leaveRoom(db, a, 'conflicted', 'reviews-renamed')
  detachConnection(db, a, 'bridge', 'conflicted')
  claimConnection(db, a, 'bridge', 'empty-resume')
  attachRooms(db, a, 'empty-resume', 'project', 'Builder')
  check('leaving every room stays left after resume', () =>
    assert.equal(subscriptions(db, a).length, 0)
  )

  db.prepare('UPDATE connection_leases SET expires_at=0 WHERE identity=?').run(a)
  claimConnection(db, a, 'bridge', 'replacement')
  attachRooms(db, a, 'replacement', 'project', 'Builder')
  joinRoom(db, a, 'replacement', 'restored', 'Restored')
  check('expired connection cannot renew, mutate or disconnect its replacement', () => {
    assert.throws(() => renewConnection(db, a, 'bridge', 'empty-resume'), /Lost/)
    assert.throws(() => joinRoom(db, a, 'empty-resume', 'bad', 'bad'), /Lost/)
    detachConnection(db, a, 'bridge', 'empty-resume')
    assertConnection(db, a, 'bridge', 'replacement')
    assert.equal(liveMemberships(db, a, 'replacement').length, 1)
  })

  const run = promisify(execFile)
  claimConnection(db, 'codex:bound-launcher', 'relay', 'relay-owner', Date.now(), 'launcher-one')
  check('bridge and relay for one identity must belong to the same launcher', () => {
    assert.throws(
      () =>
        claimConnection(db, 'codex:bound-launcher', 'bridge', 'wrong', Date.now(), 'launcher-two'),
      /another launcher/
    )
    claimConnection(db, 'codex:bound-launcher', 'bridge', 'right', Date.now(), 'launcher-one')
    assertConnection(db, 'codex:bound-launcher', 'bridge', 'right')
  })
  const script = `import {openDb} from ${JSON.stringify(new URL('./chat-db.mjs', import.meta.url).href)};
    import {claimConnection} from ${JSON.stringify(new URL('./session-store.mjs', import.meta.url).href)};
    const db=openDb(process.argv[1]);
    try { claimConnection(db,'codex:simultaneous','bridge',process.argv[2]); console.log('won'); }
    catch(e) { if(!e.message.includes('already has')) throw e; console.log('rejected'); } db.close();`
  const results = await Promise.all(
    ['one', 'two'].map((id) =>
      run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, path, id])
    )
  )
  check('two simultaneous processes have exactly one identity owner', () => {
    assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), ['rejected', 'won'])
  })
  const legacyPath = join(temp, 'legacy.db')
  let legacy = openDb(legacyPath)
  legacy.exec(`DELETE FROM schema_migrations;
    INSERT INTO seats(chat,seat,identity) VALUES ('old','Saved','claude:old'),
      ('old','Unknown','process:123'),('ambiguous','a','codex:ambiguous'),('ambiguous','b','codex:ambiguous');
    INSERT INTO cursors VALUES ('old','Saved',42);`)
  legacy.close()
  legacy = openDb(legacyPath)
  check(
    'migration preserves known identities/cursors and never guesses ambiguous or PID ownership',
    () => {
      assert.equal(subscriptions(legacy, 'claude:old')[0].seat, 'Saved')
      assert.equal(getDeliveryCursor(legacy, 'old', 'claude:old', 'claude-channel'), 42)
      assert.equal(subscriptions(legacy, 'process:123').length, 0)
      assert.equal(subscriptions(legacy, 'codex:ambiguous').length, 0)
    }
  )
  legacy.close()
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}
