#!/usr/bin/env node
// Codex resolves a contained ./ command against the installed plugin root.
// Resolve the bridge relative to this file, not the task's working directory.
// The host controls cwd; the bridge asks for workspace roots when available.
import '../dist/bridge.mjs'
