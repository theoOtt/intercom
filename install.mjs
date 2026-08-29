#!/usr/bin/env node
// Portable, idempotent installer for Claude Code + Codex Intercom integration.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { openDb } from './bridge/chat-db.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME_DIR = process.env.INTERCOM_HOME || homedir()
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME_DIR, '.claude')
const CODEX_DIR = process.env.CODEX_HOME || join(HOME_DIR, '.codex')
const DB_PATH = join(CLAUDE_DIR, 'intercom', 'chat.db')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const BACKUP_DIR = join(CLAUDE_DIR, '_backups', `intercom-${STAMP}`)
const SKIP_CLAUDE = process.argv.includes('--no-claude')
const SKIP_CODEX = process.argv.includes('--no-codex')

mkdirSync(BACKUP_DIR, { recursive: true })

function backupFile(path) {
  if (!existsSync(path)) return null
  const target = join(BACKUP_DIR, path.replace(/^\//, '').replaceAll('/', '__'))
  // Preserve the first snapshot taken during this install. Some files (notably
  // .zshrc) can be visited by both the Claude and Codex installers.
  if (!existsSync(target)) copyFileSync(path, target)
  return target
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim()
    )
  }
  return result.stdout
}

function installDependencies() {
  if (existsSync(join(ROOT, 'bridge', 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    process.stdout.write('-> bridge dependencies already installed\n')
    return
  }
  const yarn = spawnSync('yarn', ['--version'], { stdio: 'ignore' })
  if (yarn.status === 0) {
    process.stdout.write('-> installing bridge dependencies with yarn\n')
    run('yarn', ['install', '--frozen-lockfile'], { cwd: join(ROOT, 'bridge'), stdio: 'inherit' })
  } else {
    process.stdout.write('-> yarn unavailable; installing bridge dependencies with npm\n')
    run('npm', ['install'], { cwd: join(ROOT, 'bridge'), stdio: 'inherit' })
  }
}

async function backupAndMigrateDatabase() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  if (existsSync(DB_PATH)) {
    const destination = join(BACKUP_DIR, 'chat.db')
    const source = new DatabaseSync(DB_PATH)
    await backup(source, destination)
    source.close()
    process.stdout.write(`-> database backup: ${destination}\n`)
  }
  const db = openDb(DB_PATH)
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
  db.close()
  if (integrity !== 'ok') throw new Error(`database integrity check failed: ${integrity}`)
  process.stdout.write('-> database schema and integrity: OK\n')
}

function installClaude() {
  const mcp = {
    mcpServers: {
      intercom: {
        command: 'node',
        args: [join(ROOT, 'bridge', 'bridge.mjs')],
        env: { CHAT_DB: DB_PATH, CHAT_AUTOJOIN_PROJECT: '1' },
      },
    },
  }
  writeFileSync(join(ROOT, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)
  writeFileSync(
    join(ROOT, 'alias.sh'),
    `# Intercom launcher: Claude channel push + standard MCP tools.\n` +
      `claude() {\n  command claude --mcp-config "${join(ROOT, 'mcp.json')}" ` +
      `--dangerously-load-development-channels server:intercom "$@"\n}\n`
  )

  const skillDir = join(CLAUDE_DIR, 'skills', 'intercom')
  mkdirSync(skillDir, { recursive: true })
  const installedSkill = join(skillDir, 'SKILL.md')
  backupFile(installedSkill)
  copyFileSync(join(ROOT, 'skill', 'SKILL.md'), installedSkill)

  const zshrc = join(HOME_DIR, '.zshrc')
  const sourceLine = `source "${join(ROOT, 'alias.sh')}"`
  const current = existsSync(zshrc) ? readFileSync(zshrc, 'utf8') : ''
  if (!current.includes(sourceLine)) {
    backupFile(zshrc)
    appendFileSync(zshrc, `\n# Intercom: Claude Code cross-session chat\n${sourceLine}\n`)
  }
  process.stdout.write(`-> Claude skill installed: ${installedSkill}\n`)
}

function installCodex() {
  const config = join(CODEX_DIR, 'config.toml')
  mkdirSync(CODEX_DIR, { recursive: true })
  backupFile(config)

  let current = null
  const get = spawnSync('codex', ['mcp', 'get', 'intercom', '--json'], { encoding: 'utf8' })
  if (get.status === 0) current = JSON.parse(get.stdout)
  const expectedArgs = [join(ROOT, 'bridge', 'bridge.mjs')]
  const expectedEnv = { CHAT_DB: DB_PATH, CHAT_AUTOJOIN_PROJECT: '1' }
  const matches = current &&
    current.transport?.type === 'stdio' &&
    current.transport?.command === 'node' &&
    JSON.stringify(current.transport?.args) === JSON.stringify(expectedArgs) &&
    Object.entries(expectedEnv).every(([key, value]) => current.transport?.env?.[key] === value)

  if (!matches) {
    if (current) run('codex', ['mcp', 'remove', 'intercom'])
    run('codex', [
      'mcp', 'add', 'intercom',
      '--env', `CHAT_DB=${DB_PATH}`,
      '--env', 'CHAT_AUTOJOIN_PROJECT=1',
      '--', 'node', ...expectedArgs,
    ])
  }

  const skillDir = join(CODEX_DIR, 'skills', 'intercom')
  mkdirSync(skillDir, { recursive: true })
  const installedSkill = join(skillDir, 'SKILL.md')
  backupFile(installedSkill)
  copyFileSync(join(ROOT, 'codex', 'skill', 'intercom', 'SKILL.md'), installedSkill)

  const codexAlias = join(ROOT, 'codex-alias.sh')
  writeFileSync(
    codexAlias,
    `# Intercom launcher: visible Codex TUI + idle-wake relay.\n` +
      `codex-intercom() { node "${join(ROOT, 'codex', 'launch.mjs')}" "$@"; }\n`
  )
  const zshrc = join(HOME_DIR, '.zshrc')
  const sourceLine = `source "${codexAlias}"`
  const currentZsh = existsSync(zshrc) ? readFileSync(zshrc, 'utf8') : ''
  if (!currentZsh.includes(sourceLine)) {
    backupFile(zshrc)
    appendFileSync(zshrc, `\n# Intercom: Codex cross-session chat\n${sourceLine}\n`)
  }
  process.stdout.write(`-> Codex MCP and skill installed: ${installedSkill}\n`)
}

process.stdout.write(`Installing Intercom from ${ROOT}\n`)
process.stdout.write(`Recoverable backups: ${BACKUP_DIR}\n`)
installDependencies()
await backupAndMigrateDatabase()
if (!SKIP_CLAUDE) installClaude()
if (!SKIP_CODEX) installCodex()
run('node', ['--no-warnings', join(ROOT, 'bridge', 'test-db.mjs')], { cwd: ROOT })
process.stdout.write('\nIntercom installed. Restart Claude Code and Codex sessions before using directed messages.\n')
process.stdout.write('Open a new shell, then use `claude` or `codex-intercom --cwd /path/to/worktree`.\n')
