// Isolated, idempotent test for the marketplace plugin's machine bootstrap.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, sendMessage, history } from '../../bridge/chat-db.mjs'

const temp = mkdtempSync(join(tmpdir(), 'intercom-plugin-setup-'))
const codexHome = join(temp, '.codex')
const claudeHome = join(temp, '.claude')
const zshrc = join(temp, '.zshrc')
const setup = resolve('plugins/intercom/scripts/setup.mjs')
const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  process.stdout.write(`PASS: ${message}\n`)
}

mkdirSync(join(codexHome, 'skills', 'intercom'), { recursive: true })
mkdirSync(join(claudeHome, 'skills', 'intercom'), { recursive: true })
writeFileSync(join(codexHome, 'skills', 'intercom', 'SKILL.md'), 'legacy codex skill\n')
writeFileSync(join(claudeHome, 'skills', 'intercom', 'SKILL.md'), 'legacy claude skill\n')
writeFileSync(join(codexHome, 'config.toml'), `
model = "gpt-5.6-sol"
model_context_window = 1000000

[mcp_servers.intercom]
command = "node"
args = ["/legacy/bridge.mjs"]
`)
writeFileSync(zshrc, `export KEEP_ME=1
source "/legacy/intercom/alias.sh"
source "/legacy/intercom/codex-alias.sh"
`)
const dbPath = join(claudeHome, 'intercom', 'chat.db')
mkdirSync(join(claudeHome, 'intercom'), { recursive: true })
let db = openDb(dbPath)
sendMessage(db, 'preserved', 'test', 'keep this message')
db.close()

try {
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, [setup], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        INTERCOM_HOME: temp,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
      },
    })
    if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`)
  }

  const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  assert(config.includes('model = "gpt-5.6-sol"'), 'setup preserves unrelated Codex settings')
  assert(config.includes('model_context_window = 1000000'), 'setup preserves context-window settings')
  assert(!config.includes('[mcp_servers.intercom]'), 'setup removes only the legacy Intercom MCP entry')

  const shellFile = join(temp, '.config', 'intercom', 'shell.zsh')
  const shell = readFileSync(shellFile, 'utf8')
  assert(shell.includes('--dangerously-load-development-channels plugin:intercom@intercom'), 'Claude wrapper enables the installed channel plugin via the development flag')
  assert(shell.includes('.local/share/intercom/codex/launch.mjs'), 'Codex wrapper uses the stable relay runtime')
  const syntax = spawnSync('zsh', ['-n', shellFile])
  assert(syntax.status === 0, 'generated zsh integration is syntactically valid')

  const installedZsh = readFileSync(zshrc, 'utf8')
  assert(installedZsh.includes('export KEEP_ME=1'), 'setup preserves unrelated shell configuration')
  assert(!installedZsh.includes('/legacy/intercom/'), 'setup removes legacy Intercom source lines')
  assert(installedZsh.includes(shellFile), 'setup sources the marketplace shell integration')

  assert(existsSync(join(temp, '.local', 'share', 'intercom', 'codex', 'launch.mjs')),
    'setup installs the stable Codex relay runtime')
  assert(existsSync(join(temp, '.local', 'share', 'intercom', 'bridge', 'bridge.mjs')),
    'setup installs the stable bundled MCP bridge')
  assert(!existsSync(join(codexHome, 'skills', 'intercom')),
    'setup retires the standalone Codex skill after plugin installation')
  assert(!existsSync(join(claudeHome, 'skills', 'intercom')),
    'setup retires the standalone Claude skill after plugin installation')

  db = openDb(dbPath)
  assert(history(db, 'preserved').some((row) => row.body === 'keep this message'),
    'setup preserves the existing SQLite chat database')
  db.close()
  assert(existsSync(join(claudeHome, '_backups')), 'setup creates recoverable backups')
} finally {
  try { db?.close() } catch {}
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
