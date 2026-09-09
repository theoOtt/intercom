# Session ownership and delivery (0.5)

The durable owner is `codex:<thread.id>` or `claude:<session UUID>`. Codex's separate
`thread.sessionId` can be shared by forks and is not used for ownership. Bridges without a
resumable ID reject room operations with launch instructions. Project directories select a default room only.

`session_records` records identities already initialized, including those that explicitly left
every room. `subscriptions` records one last-used seat per identity and room. `seats` and
`presence` record only live membership. Closing the bridge removes live rows but keeps subscriptions
and identity-based delivery cursors; explicit `leave` removes that room subscription and cursors.
Room rename moves subscriptions, cursors and receipts transactionally. An occupied saved name is
reported in bridge stderr and `chats()`; the subscription remains pending. Resolve by explicitly
joining with a chosen available name, or leave the saved subscription. No automatic takeover occurs.

The Codex launcher always starts with an unclaimed startup token. The relay resolves the actual
loaded thread (including the resume picker, --last and fork), claims a relay lease, and writes its
thread ID into the private identity file. Only then may the bridge claim its connection and restore
rooms. No provisional room or direct-message ownership is merged into a saved identity.
The MCP initialize client identifies the host: a nested Claude reviewer uses its own Claude ID
even if it inherits a Codex identity-file variable; a nested Codex ignores inherited Claude IDs.

Bridge and relay leases have separate random connection tokens, renew every five seconds and
expire after thirty seconds. Claims are serialized with SQLite write transactions. Codex connections
are also bound to the same launcher identity file, preventing a relay from pairing with another
launcher's bridge. Expired connection tokens
cannot renew, mutate membership/cursors or detach replacement connections. Duplicate live owners
are rejected. After an abrupt crash, reconnect may need to wait for lease expiry. Same-thread
simultaneous opens are not supported; use a fork for a separate participant.

For Codex, `turn/steer` delivers into an active turn using its expected turn ID; `turn/start` wakes
an idle thread. A long-running command can still delay the next model boundary; steering does not
kill commands. JSON-RPC rejection leaves the message pending for retry against refreshed state.
Each room has a separate accepted-delivery cursor; pending messages are selected in database order.

`delivery_receipts` distinguishes `submitting`, `pending`, `accepted`, and `uncertain`. Successful
RPC acceptance and cursor advancement are committed together. Turn completion, when observed, is
recorded as additional detail but is not called a read receipt. Actual processing is only confirmed
by a model acknowledgement, as exercised in the opt-in live test.

A timeout/disconnection or crash after submission can leave acceptance ambiguous. The relay logs
`DELIVERY UNCERTAIN`, retains the cursor, and stops automatic resend of that message. Inspect the
thread transcript for the room/message ID. Only after resolving the outcome should an operator
mark its receipt accepted or pending in the database. This intentionally avoids promising exactly
once processing across an unacknowledged network request. An unresolved oldest message pauses
subsequent delivery for that relay to preserve ordering.

## Upgrade

Run the marketplace update and cached setup before restarting all participating Claude and Codex
sessions. Setup creates a consistent SQLite backup first. Stop using older bridges during cutover:
they do not implement connection fencing or persistent subscriptions. Reload the shell wrapper
or open a new terminal, then resume the stored conversations. `chats()` shows restored rooms,
identity and conflicts. There is no need to rejoin successfully restored rooms manually.

Migration preserves messages and existing identity cursors. Only existing stable seat records with
an unambiguous identity/room pair become saved subscriptions; Claude seat cursors are copied into
identity cursors. Legacy process IDs and ambiguous multiple-seat records are not assigned to a
conversation by guessing. Rooms from sessions already closed before migration may need one explicit
join; older releases deleted that information on exit. SQLite remains local to each laptop.

## Tests

From the repository root:

```sh
node --no-warnings bridge/test-sessions.mjs
node --no-warnings bridge/test-lifecycle.mjs
node --no-warnings codex/test-relay.mjs
INTERCOM_LIVE_CLAUDE_TEST=1 node --no-warnings bridge/test-claude-identity.mjs
INTERCOM_LIVE_CODEX_TEST=1 node --no-warnings codex/test-live-lifecycle.mjs
```

The live tests make small model calls using the installed accounts. They use disposable databases,
not the user's active Intercom rooms. The Codex test steers during a real shell command, checks the
acknowledgement and original task completion, restarts/resumes the App Server, and checks fork IDs.
