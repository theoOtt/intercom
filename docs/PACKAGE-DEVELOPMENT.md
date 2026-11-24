# Package source and provenance

Development version: 0.5.6-dev.20261124.

The source integration starts from the 0.5.3 repository and retains the existing Copilot adapter changes. Desktop delivery, receipt arbitration, transcript reconciliation, SQLite retry and persistent-worker recovery were recovered from the accepted local package implementation into explicit project modules. Third-party SDK code is not recovered into source: the build resolves the pinned MCP SDK through the dependency lockfile.

Recovered code remains ordinary source, with readable local binding names and explicit imports/exports. The retained legacy data-layer exports support the CLI, import and existing consumers. Build output is generated with esbuild; a bundle is never used as the source entry point.

`bridge/build-plugin.mjs` builds the MCP bundle, copies CLI runtime modules and all canonical Desktop helper sources, and builds the independent read-only owner adapter. The Codex hook manifest, MCP transport and tools ship together. `bridge/build-copilot.mjs` builds the standalone MCP bridge and optional SDK extension independently.

Default fixtures prove source build, database ownership/privacy, session restoration, MCP contracts, Copilot relay behavior and packaging in temporary homes. Focused Desktop/busy fixtures prove the guarded source and SQLite transitions. They do not prove that a user's host has admitted hooks or a Copilot preview extension. Real Desktop active/idle acceptance, native same-turn steering and host policy admission must be recorded separately.

The normal setup provisions one generic configuration for enrolled Desktop identities and a matching persistent service. It preserves existing configuration and refuses to replace a running service. No release process should copy conversation names, test allowances, test UUIDs, private instruction files or machine-specific configuration into this source package.

Codex marketplace selection uses the generated `plugins/intercom-codex` native plugin distribution, because the tested Desktop runtime intentionally omits hooks for Agent Plugins manifests. Claude retains `plugins/intercom` and its own channel descriptor. Both distributions share the same name, version, MCP source and generated runtime; users install one normal marketplace entry per product, not a second competing bridge.
