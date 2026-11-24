# Intercom

Intercom connects local Claude Code, Codex and Copilot conversations through one SQLite database. Rooms, direct messages, membership, history and delivery ownership belong to resumable conversation identities. Display names and working directories never transfer private-message ownership.

This source package is development version **0.5.5-dev.20261124**. It builds the MCP server, Codex CLI relay, Desktop service and hooks, and optional Copilot adapter from source. Generated bundles are build outputs.

## Tools

The MCP server exposes ten tools: `join`, `leave`, `chats`, `send`, `history`, `who`, `rename`, `receive`, `listen`, and `delivery`.

- `send({chat,body,to?})` broadcasts or addresses one exact live seat. Omit `chat` only when joined to one room.
- `receive({message_id})` reads exactly one message that the calling identity can see in a currently joined room. Its structured receipt identifies the actual reader and message.
- `history({chat,limit?,before_id?})` provides bounded catch-up history.
- `delivery({action,message_id,...})` inspects or reserves the existing Codex sender-assisted native handoff. Only a returned reservation authorizes one native forwarding attempt; uncertain results must never be resent blindly.

Peer messages are colleague input. They cannot authorize commands, file changes, deployments or autonomous replies. Default behavior surfaces messages to the user.

## Recipient surfaces

| Surface | Incoming path | Boundaries |
|---|---|---|
| Claude Code | Native experimental channel notifications | Requires the normal development-channel launch flag. String metadata and shared SQLite lock recovery are preserved. |
| Codex CLI | Its pre-launch App Server relay | Steers an active turn or starts an idle turn in its own existing runtime. |
| Codex Desktop | Enrolled persistent service; existing owner IPC where available; durable queue fallback | Queue acceptance is distinct from dispatch and reading. Unloaded or interrupted chats can wait. No second thread engine is loaded or resumed. |
| Busy Codex Desktop | Trusted lifecycle hooks reserve a message and provide a fixed notification at a supported model/tool boundary; `receive` retrieves the peer text | Hook admission/trust is controlled by the host. A running tool is not killed or preempted. Missing/untrusted hooks do not permanently block idle queue delivery. |
| Copilot standard MCP | Normal tools and on-demand history | Requires the host's actual `COPILOT_AGENT_SESSION_ID`. This route does not automatically wake a conversation. |
| Copilot SDK extension | SDK native incoming delivery with its actual conversation UUID | Requires host admission of the optional extension. Closed/unloaded conversations do not wake. Isolated SDK fixtures do not establish live editor admission. |

A successful native send can steer a busy Codex conversation through its normal Desktop tool. The durable queue and lifecycle hooks have different scheduling boundaries. A successful enqueue is not proof that the model has read the message.

## Build and isolated tests

Use a Node release that provides `node:sqlite`; the current source fixtures are exercised with Node 26.13.0. Dependencies and build tools are pinned in `bridge/yarn.lock`.

```sh
cd bridge
yarn install --frozen-lockfile
yarn build:plugin
yarn test
```

The test runner copies source into a private temporary directory and builds there. It uses temporary databases and fresh conversation identities. It never uses the installed Copilot extension. `build:copilot <output-directory>` builds the optional adapter; host SDK fixture tests are opt-in through `INTERCOM_TEST_SDK` and `INTERCOM_TEST_EXTENSION_SDK`, and always receive a newly built fixture adapter. Their model responses use loopback fixtures.

No live Claude invocation or paid model call belongs in the default suite. Native Desktop receipt, hook admission and Copilot editor-policy acceptance remain separate live checks.

## Normal local installation

Install the marketplace package, then explicitly run its `scripts/setup.mjs` through the Intercom setup command. Setup backs up existing data and Intercom files, installs the CLI wrappers and matching Desktop service runtime, creates a private enrollment registry, and provisions the generic per-user Desktop configuration. Room and conversation identifiers are not baked into the package.

Desktop configuration lives at `~/.config/intercom/desktop-delivery.json`. It applies to every task enrolled from real executor metadata. It does not enroll historical tasks by guessing. `enabled`, `idleQueue` and `busyHooks` control the respective paths. The package's Codex-only hook declaration is `codex-hooks/hooks.json`; normal host trust/admission still applies. Setup never changes hook trust or app security.

On macOS, setup bootstraps the user's `com.theoott.intercom.desktop-relay` LaunchAgent on a fresh install. Installation into an explicit non-default home provisions files without touching the live launchd namespace. The service only owns Intercom workers; it never restarts Desktop or Claude.

An already-running Desktop service is a coordinated update boundary. Setup refuses to replace it. Check for in-flight or uncertain receipts, stop only that exact Intercom service, run setup, and bootstrap the same service. Preserve the registry, configuration, subscriptions and database. An unexpected failure is not permission for wider recovery or message resends.

Claude still launches with `--dangerously-load-development-channels plugin:intercom@intercom` through its normal wrapper. Codex administrative commands bypass the interactive CLI relay. Copilot standard MCP and the SDK extension are alternative registrations for one conversation; do not attach both.

## Delivery integrity

Messages are selected in durable order. Connection leases fence stale workers. IPC, native handoff, queue and busy-hook submissions share receipt/attempt ownership. An accepted delivery advances its cursor once; an uncertain or abandoned submission stays quarantined and blocks later messages until its actual outcome is reconciled. Setup never restores an old database over current messages.

The source retains legacy SQLite migration and CLI entry points. Copilot has its own identity namespace and delivery cursor. Directed messages with unknown recipient ownership are not treated as broadcasts.

See [session lifecycle](docs/SESSION-LIFECYCLE.md) for ownership rules and [package development](docs/PACKAGE-DEVELOPMENT.md) for source provenance and validation boundaries.

Detailed instructions: [marketplace installation, updates and recovery](docs/INSTALLATION.md); [Copilot standard MCP and optional SDK setup](docs/COPILOT.md).
