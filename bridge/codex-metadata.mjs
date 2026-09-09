// Executor-supplied MCP metadata, never a model argument, seat label, project
// path, transcript search, or inherited parent-session environment variable.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function codexThreadId(meta) {
  if (!meta || typeof meta !== 'object') return null
  let turn = meta['x-codex-turn-metadata']
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn) } catch { throw new Error('Invalid Codex turn metadata') }
  }
  const candidates = [
    ...['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id',
      'threadId', 'thread_id'].map((key) => meta[key]),
    turn?.thread_id, meta.thread?.id,
  ].filter((value) => value !== undefined && value !== null)
  if (!candidates.length) return null
  if (candidates.some((value) => typeof value !== 'string' || !UUID.test(value)) ||
      new Set(candidates).size !== 1) throw new Error('Conflicting or invalid Codex thread metadata')
  return candidates[0]
}
