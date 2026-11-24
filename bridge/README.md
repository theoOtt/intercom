# Intercom MCP bridge

The canonical bridge source serves nine tools and Claude's native channel. Delivery state, peer envelopes, SQLite recovery and session ownership are separate modules. Codex-specific transports live in `codex/`; portable Desktop service sources live in `scripts/`.

Build with `yarn build:plugin` from this directory. `yarn test` builds and tests a private source copy, including Copilot source fixtures; it never targets an installed extension. See the repository [README](../README.md) for setup, runtime surfaces and delivery limitations.
