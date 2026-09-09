# Existing Desktop runtime IPC test — 2026-09-09

Result: **idle wake and active-turn delivery passed in normal Desktop.**
This supersedes the replacement-runtime approach as the direction for Intercom.
It does not yet constitute an installed automatic Desktop relay.

## Scope

Used the existing same-user IPC router at `~/.codex/ipc/ipc.sock` and its
task-owner discovery / follower request handlers. The probe registered as
`intercom-disposable-task-test`, not as a first-party client. It checked socket
ownership and permissions, discovered the target's owner, and addressed requests
to that owner. It did not claim task ownership, answer approval requests, access
the protected app-tools socket, or retry an uncertain submission.

No replacement App Server, custom Desktop launch, configuration edits, sign-in,
pairing changes, or runtime restarts were used. Normal Desktop PID 12365 and its
existing App Server PID 12408 remained running throughout.

## Evidence

The normal app's task-creation tool created the disposable task:

- Title: `Intercom existing-runtime delivery test`
- UUID: `01a087f0-e7c3-7c41-827d-6836269e4e40`
- Host: `local`

| Check | Observed result |
| --- | --- |
| Built-in Desktop tool before delivery | `get_usage_limits` completed; task replied `DESKTOP_TOOLS_READY` |
| Idle delivery | `thread-follower-start-turn` returned success; new turn `01a087f2-05d5-7db3-982f-ab8d5d9b208e` completed with `IPC_IDLE_RECEIVED` |
| Active work | Task ran `sleep 30`; process 14880 was observed under the existing App Server |
| Active delivery | `thread-follower-steer-turn` returned success with the original active turn ID `01a087f2-59ac-7c73-a087-142ac80f9183` |
| Completion | Original turn finished with `ORIGINAL_WORK_DONE IPC_BUSY_RECEIVED` |
| Built-in tool afterward | `get_usage_limits` completed in that same turn |
| Existing phone connection | User confirmed the test conversation was visible through the existing pairing |
| Existing other-laptop connection | The normal app's `read_thread` successfully fetched a task through its configured `remote-control:` host; no SSH or remote task mutations were used |

The disposable task remains available for inspection. Do not archive or delete it
without the user's direction while they are checking it from their phone.

## Limits and next implementation work

- The IPC interface is private and versioned. Readiness and protocol mismatches
  must fail clearly; this is not a documented public compatibility guarantee.
- Messages were synthetic test messages, not yet consumed automatically from the
  Intercom database. Integrate the proven transport with durable receipts/cursors,
  directed recipient filtering, multi-room subscriptions, and fenced connections.
- The test proves steering during a running command and later acknowledgment,
  not immediate model processing or cancellation of that command.
- Phone visibility and a read-only remote fetch passed. Phone-originated prompts,
  remote command execution, and approval-dialog round trips were not exercised.
- A single read-only app tool passed before and after delivery; this is not a
  complete audit of every browser/computer-use tool.
- Test owner changes, disconnected/closed tasks, resume/fork isolation, Desktop
  restart, duplicate attachment, uncertain delivery, and active/idle races before
  releasing the automatic adapter. Never start a second engine over an owned task.

Probe source: `codex/test-desktop-ipc.mjs`. Run it only against a user-authorized
disposable task, not against active production work. This probe is not an installer.

## Automatic MCP/SQLite adapter validation

The new `codex/desktop-relay.mjs` is started by metadata-bound MCP bridges and polls
their owned rooms every 1.2 seconds. `codex/desktop-ipc.mjs` discovers the existing
Desktop owner for each delivery, attempts steering first, and falls back to starting
a turn only on Desktop's explicit inactive-turn rejection. No new engine is started.

The full generated MCP bundle was tested against the same normal Desktop task using
`bridge/test-desktop-live.mjs` and a temporary SQLite database. A second MCP client
sent the peer messages; the test harness did not manually invoke the IPC send operation.

- `AUTO_IDLE_TOKEN`: automatically delivered and surfaced by the idle task.
- `AUTO_BUSY_TOKEN`: sent directly to its seat in a second room while `sleep 30`
  was running; accepted into original turn `01a087fb-f61a-7162-bbc0-5c69029f9dd5`.
  Task finished with `AUTO_ORIGINAL_DONE AUTO_BUSY_TOKEN` and successfully called
  the normal built-in `get_usage_limits` tool afterward.
- Bridge disconnected, a room broadcast was queued, and bridge was recreated with
  the same executor UUID. A `chats()` call restored `ipc-auto-one/Desktop-A` and
  `ipc-auto-two/Desktop-B` without join calls. `AUTO_RECONNECT_TOKEN` was delivered
  automatically and surfaced in turn `01a087fd-100a-7b33-858a-46bdf89c7009`.
- An explicit leave prevented delivery of a subsequent message to the left room.
- The temporary bridges were stopped and their database removed. The Desktop task
  remains available for the user's phone inspection.

Automated tests also cover multi-room ordering, directed-message filtering, duplicate
leases, stale fencing, pre-submission leave, in-flight rename, safe offline retry,
uncertain-disconnect pauses, and IPC framing/owner targeting. The existing CLI relay
regressions and bridge lifecycle tests pass.

Installed local development build: `0.5.1+codex.20260909210524`.
Config backup: `~/.codex/intercom-install-backup-dKukNz/config.toml`; comparison after
installation confirmed the main config was unchanged. No phone/laptop pairing changes.

Remaining boundaries: first MCP call is still required after connection recreation;
an unloaded task with no Desktop owner remains pending rather than being reopened by
another engine. The IPC interface is private and Unix-socket only. Actual application
restart and all approval/UI/platform cases are not claimed as tested by this run.
