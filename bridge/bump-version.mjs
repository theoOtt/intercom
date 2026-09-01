#!/usr/bin/env node
// Bump the plugin version everywhere it is declared. `claude plugin update` only
// pulls a new build when the manifest version changes, so every release needs this.
//
//   yarn bump patch|minor|major     # or: node bump-version.mjs 0.5.0
//   yarn bump patch --dry-run
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLAUDE_MANIFEST = join(ROOT, 'plugins', 'intercom', '.claude-plugin', 'plugin.json')
const CODEX_MANIFEST = join(ROOT, 'plugins', 'intercom', '.codex-plugin', 'plugin.json')
const BRIDGE_PACKAGE = join(ROOT, 'bridge', 'package.json')

const fail = (message) => {
  console.error(`bump-version: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const target = args.find((arg) => !arg.startsWith('--'))
if (!target) {
  console.error('usage: bump-version.mjs <patch|minor|major|x.y.z> [--dry-run]')
  process.exit(2)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const current = readJson(CLAUDE_MANIFEST).version
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
if (!parsed) fail(`current version ${current} in ${CLAUDE_MANIFEST} is not x.y.z`)
const [major, minor, patch] = parsed.slice(1).map(Number)

let next
switch (target) {
  case 'major': next = `${major + 1}.0.0`; break
  case 'minor': next = `${major}.${minor + 1}.0`; break
  case 'patch': next = `${major}.${minor}.${patch + 1}`; break
  default:
    if (!/^\d+\.\d+\.\d+$/.test(target)) fail(`${target} is not patch, minor, major or x.y.z`)
    next = target
}
if (next === current) fail(`version is already ${current}`)

// Codex builds carry a UTC build stamp so repeated publishes of one version stay distinct.
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const codexNext = `${next}+codex.${stamp}`

// Rewrite only the version line so formatting and key order are untouched.
function setVersion(path, value) {
  const source = readFileSync(path, 'utf8')
  const updated = source.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${value}$2`)
  if (updated === source) fail(`no "version" field found in ${path}`)
  if (!dryRun) writeFileSync(path, updated)
  console.log(`${dryRun ? 'would set' : 'set'} ${path.slice(ROOT.length + 1)} -> ${value}`)
}

setVersion(CLAUDE_MANIFEST, next)
setVersion(CODEX_MANIFEST, codexNext)
setVersion(BRIDGE_PACKAGE, next)

console.log(`\n${current} -> ${next}${dryRun ? ' (dry run, nothing written)' : ''}`)
if (!dryRun) {
  console.log(`\nnext: git commit -am "Bump plugin version to ${next}" && git push`)
  console.log('then on each machine: claude plugin marketplace update intercom && claude plugin update intercom@intercom')
}
