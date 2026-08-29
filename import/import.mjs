// import.mjs -- one-time importer: file-based session-chat history -> Intercom SQLite.
// NON-DESTRUCTIVE: snapshots the source first and never deletes the originals.
// Usage:
//   node import.mjs --dry-run          # preview what would be imported (default-safe)
//   node import.mjs                    # back up source, then import
//   node import.mjs --src <dir> --db <path>
import { readdirSync, readFileSync, statSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { openDb, importMessage, maxId } from '../bridge/chat-db.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const DRY = args.includes('--dry-run')
const SRC = opt('--src', join(homedir(), '.claude', 'session-chat'))
const DB = opt('--db', join(homedir(), '.claude', 'intercom', 'chat.db'))

if (!existsSync(SRC)) { console.error(`source not found: ${SRC}`); process.exit(1) }

// Parse a <seat>.md file into message blocks:
//   ---\nseq: N\nfrom: X\ntime: T\n---\n<body>
function parseBlocks(content, fallbackSeat) {
  const blocks = []
  const re = /---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*?)(?=\n---\s*\nseq:|\s*$)/g
  let m
  while ((m = re.exec(content))) {
    const header = m[1]
    const body = m[2].trim()
    if (!/(^|\n)seq:/.test(header)) continue
    const from = (header.match(/from:\s*(.*)/)?.[1] || fallbackSeat).trim()
    const time = (header.match(/time:\s*(.*)/)?.[1] || '').trim()
    if (!body) continue
    blocks.push({ seat: from, ts: time, body })
  }
  return blocks
}

const chatDirs = readdirSync(SRC).filter((d) => {
  try { return statSync(join(SRC, d)).isDirectory() } catch { return false }
})

const perChat = {}
for (const chat of chatDirs) {
  const dir = join(SRC, chat)
  const msgs = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const seat = basename(f, '.md')
    for (const b of parseBlocks(readFileSync(join(dir, f), 'utf8'), seat)) msgs.push(b)
  }
  msgs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) // chronological
  perChat[chat] = msgs
}

console.log(`Source: ${SRC}`)
console.log(`Target: ${DB}${DRY ? '   (DRY RUN -- nothing written)' : ''}`)
console.log(`Chats found: ${chatDirs.length}\n`)
let total = 0
for (const [chat, msgs] of Object.entries(perChat)) {
  const first = msgs[0]?.ts || '-'
  const last = msgs[msgs.length - 1]?.ts || '-'
  console.log(`  ${chat.padEnd(30)} ${String(msgs.length).padStart(5)} msgs   ${first}  ->  ${last}`)
  total += msgs.length
}
console.log(`\nTotal messages: ${total}`)

if (DRY) { console.log('\nDry run complete. Re-run without --dry-run to import.'); process.exit(0) }

// Non-destructive snapshot before writing anything.
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(homedir(), '.claude', '_backups', `session-chat-${stamp}`)
mkdirSync(join(homedir(), '.claude', '_backups'), { recursive: true })
cpSync(SRC, backup, { recursive: true })
console.log(`\nBacked up source -> ${backup}`)

const db = openDb(DB)
let imported = 0
for (const [chat, msgs] of Object.entries(perChat)) {
  const existing = maxId(db, chat)
  if (existing > 0) { console.log(`  skip "${chat}": target already has messages (avoiding duplicates)`); continue }
  for (const m of msgs) { importMessage(db, chat, m.seat, m.body, m.ts || new Date().toISOString()); imported++ }
  console.log(`  imported "${chat}": ${msgs.length}`)
}
console.log(`\nDone. Imported ${imported} messages -> ${DB}. Originals untouched at ${SRC}.`)
