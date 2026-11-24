import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(message, neverSpawned = false) {
  const error = new Error(message);
  if (neverSpawned) error.intercomQueueNeverSpawned = true;
  return error;
}

// Runs an ephemeral public stdio app-server. This process never loads a thread.
// Message content travels only on stdin, never process arguments or diagnostics.
export async function deliverQueueMessage(options, guard = () => true) {
  const { binary, cwd, threadId, prompt, timeoutMs = 15000, env = process.env } = options ?? {};
  const clientUserMessageId = options?.clientUserMessageId ?? randomUUID();
  if (!isAbsolute(binary ?? '') || !isAbsolute(cwd ?? '') || !UUID.test(threadId ?? '') ||
      !UUID.test(clientUserMessageId) || typeof prompt !== 'string' || !prompt.length ||
      prompt.length > 1000000 || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw failure('Invalid public queue writer configuration or input', true);
  }
  try { await access(binary, constants.X_OK); await access(cwd, constants.R_OK); }
  catch { throw failure('Public queue writer executable or working directory unavailable', true); }
  try { if (await guard() === false) throw new Error('guard declined'); }
  catch { throw failure('Public queue writer guard declined before spawn', true); }

  return new Promise((resolve, reject) => {
    let child, spawned = false, settled = false, buffer = '', phase = 'initialize';
    let shutdownTimer;
    const cleanup = () => {
      clearTimeout(timer);
      if (child?.stdin.writable) child.stdin.end();
      // Only this helper's PID is ever signalled; the receiver is another process.
      if (child && child.exitCode === null && child.signalCode === null) {
        shutdownTimer = setTimeout(() => child.kill('SIGTERM'), 2000);
        shutdownTimer.unref();
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const fail = (reason) => finish(failure(reason, !spawned));
    const send = (message) => {
      try { child.stdin.write(JSON.stringify(message) + '\n', (err) => { if (err) fail('Public queue writer stdin failed'); }); }
      catch { fail('Public queue writer stdin failed'); }
    };
    const timer = setTimeout(() => fail('Public queue writer timed out; outcome requires reconciliation'), timeoutMs);
    try { child = spawn(binary, ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { fail('Public queue writer could not spawn'); return; }
    child.once('spawn', () => {
      spawned = true;
      send({id: 1, method: 'initialize', params: {clientInfo: {name: 'intercom-public-queue-writer', version: '1'}, capabilities: {experimentalApi: true}}});
    });
    child.once('error', () => fail('Public queue writer process failed'));
    child.once('close', () => { clearTimeout(shutdownTimer); if (!settled) fail('Public queue writer exited before acknowledgement'); });
    child.stdin.on('error', () => fail('Public queue writer stdin closed'));
    child.stderr.on('data', () => {}); // Drain, but never disclose server text or prompts.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > 4000000) { fail('Public queue writer response exceeded limit'); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('Public queue writer returned invalid JSON'); return; }
        if (phase === 'initialize' && message.id === 1) {
          if (message.error || !message.result) { fail('Public queue writer initialization rejected'); return; }
          phase = 'enqueue';
          send({method: 'initialized'});
          send({id: 2, method: 'thread/queue/add', params: {threadId, clientUserMessageId, input: [{type: 'text', text: prompt, text_elements: []}]}});
        } else if (phase === 'enqueue' && message.id === 2) {
          const item = message.result?.queuedSubmission;
          if (message.error || typeof item?.id !== 'string' || !item.id ||
              item.clientUserMessageId !== clientUserMessageId ||
              item.input?.length !== 1 || item.input[0]?.type !== 'text' || item.input[0]?.text !== prompt) {
            fail('Public queue writer acknowledgement rejected or mismatched'); return;
          }
          phase = 'accepted';
          finish(null, {queued: true, threadId, queueId: item.id, clientUserMessageId});
        }
      }
    });
  });
}
