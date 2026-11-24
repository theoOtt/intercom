// Explicit product opt-in only. Never edits Claude settings or conversations.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, lstatSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {configPath, privateJson, MAX_WAIT_MS, unresolvedHooks} from './delivery.mjs';
const action = process.argv[2];
const file = configPath();
if (!['enable', 'disable', 'status'].includes(action)) throw Error('Usage: configure.mjs enable|disable|status [--database /absolute/chat.db]');
const previous = existsSync(file) ? privateJson(file) : null;
if (action === 'status') {
  console.log(JSON.stringify(previous || {enabled: false}));
} else {
  const directory = dirname(file);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Unsafe Intercom configuration directory');
  if (action === 'enable' && previous?.enabled === true) throw Error('Claude hooks already enabled; disable explicitly before creating a new cutover');
  let config;
  if (action === 'disable') config = {...previous, enabled: false};
  else {
    const option = process.argv.indexOf('--database');
    const database = resolve(option < 0 ? join(homedir(), '.claude/intercom/chat.db') : process.argv[option + 1] || '');
    const stat = lstatSync(database);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('Unsafe Intercom database');
    const db = new DatabaseSync(database, {readOnly: true});
    let cutoff;
    try {
      if (unresolvedHooks(db)) throw Error('Unresolved Claude hook deliveries must be reconciled before enabling a new cutover; no receipt was changed');
      cutoff = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id;
    } finally { db.close(); }
    config = {version: 1, enabled: true, transport: 'hooks', database,
      stateDir: join(directory, 'claude-hooks'), generation: randomUUID(), afterMessageId: cutoff, waitTimeoutMs: MAX_WAIT_MS};
  }
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  renameSync(temporary, file);
  console.log(action === 'enable' ? 'Claude hook transport configured for future explicit opt-in attachments. Set INTERCOM_CLAUDE_TRANSPORT=hooks through the documented Desktop local environment controls. No Claude configuration or live receipt was changed.' : 'Claude hook configuration disabled. Existing hook sessions stop receiving; they never switch silently to native channels. No receipt or cursor was changed.');
}
