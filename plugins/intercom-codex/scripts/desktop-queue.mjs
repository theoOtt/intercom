import {deliveryConfig} from './delivery-core.mjs';
import {openSync, fstatSync, readSync, closeSync, constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {deliverQueueMessage} from '../scripts/queue-writer.mjs';

const BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const EXPECTED_SHA = 'e1c3d034b7fd295d160d6ab412357f9c54241c8ed7a2a861f4730b8a4dd88ddb';
const environment = () => ({HOME: homedir(),
  CODEX_HOME: process.env.CODEX_HOME || join(homedir(), '.codex'),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8'});
let binaryKey = null;

function trustedBinary() {
  let fd;
  try {
    fd = openSync(BINARY, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022))
      throw Error('Unsafe bundled queue executable');
    const key = value => [value.dev, value.ino, value.size, value.mode, value.uid,
      value.mtimeMs, value.ctimeMs].join(':');
    const current = key(stat);
    if (binaryKey === current) return;
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    if (current !== key(fstatSync(fd)))
      throw Error('Desktop executable changed during verification; queue fallback disabled');
    if (hash.digest('hex') !== EXPECTED_SHA)
      throw Error('Desktop executable updated; queue fallback disabled until its exact version/protocol are reverified and the pinned digest is updated');
    binaryKey = current;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function desktopQueueStatus(threadId) {
  try {
    const config = deliveryConfig(threadId);
    if (!config || config.idleQueue !== true) return {state: 'disabled'};
    trustedBinary();
    return {state: 'enrolled_queue_configured', threadId,
      afterMessageId: config.afterMessageId, loadedNow: 'unknown'};
  } catch (error) { return {state: 'unavailable', error: error.message}; }
}

export function loadDesktopQueue(threadId) {
  const initial = deliveryConfig(threadId);
  if (!initial || initial.idleQueue !== true) return null;
  return {...initial, async deliver(target, notice, guard) {
    const current = deliveryConfig(target);
    if (!current || current.idleQueue !== true || JSON.stringify(current) !== JSON.stringify(initial))
      throw Error('Intercom queue enrollment/configuration changed before invocation');
    trustedBinary();
    return deliverQueueMessage({binary: BINARY, cwd: homedir(), threadId: target,
      prompt: notice, timeoutMs: 15000, env: environment()}, guard);
  }};
}
