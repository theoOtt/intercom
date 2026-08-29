// Minimal Codex App Server JSON-RPC client for the local Intercom relay.
// The WebSocket transport is experimental, so protocol handling lives in this
// isolated module and can be updated without touching the SQLite/MCP bridge.
import { EventEmitter } from 'node:events'

export class AppServerClient extends EventEmitter {
  constructor(endpoint, { requestTimeoutMs = 30_000, clientName = 'intercom_relay' } = {}) {
    super()
    this.endpoint = endpoint
    this.requestTimeoutMs = requestTimeoutMs
    this.clientName = clientName
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.serverRequestHandler = null
    this.closing = false
  }

  async connect() {
    if (this.socket) return
    this.closing = false
    this.socket = new WebSocket(this.endpoint)
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (event) => {
        cleanup()
        reject(new Error(`unable to connect to Codex App Server at ${this.endpoint}: ${event.message || 'WebSocket error'}`))
      }
      const cleanup = () => {
        this.socket.removeEventListener('open', onOpen)
        this.socket.removeEventListener('error', onError)
      }
      this.socket.addEventListener('open', onOpen)
      this.socket.addEventListener('error', onError)
    })

    this.socket.addEventListener('message', (event) => this.#onMessage(String(event.data)))
    this.socket.addEventListener('close', () => this.#onClose())
    this.socket.addEventListener('error', (event) => {
      if (!this.closing) this.#emitError(event.error || new Error('App Server WebSocket error'))
    })

    await this.request('initialize', {
      clientInfo: {
        name: this.clientName,
        title: 'Intercom Relay',
        version: '0.2.0',
      },
    })
    this.notify('initialized', {})
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('App Server client is not connected'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`App Server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.#send({ method, id, params })
    })
  }

  notify(method, params = {}) {
    this.#send({ method, params })
  }

  close() {
    if (!this.socket) return
    this.closing = true
    this.socket.close()
  }

  #send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('App Server WebSocket is not open')
    }
    this.socket.send(JSON.stringify(message))
  }

  async #onMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      this.#emitError(new Error(`invalid JSON from App Server: ${raw.slice(0, 200)}`))
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(`${pending.method} failed: ${message.error.message || 'unknown error'}`)
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id !== undefined && message.method) {
      try {
        if (!this.serverRequestHandler) throw new Error(`unsupported server request: ${message.method}`)
        const result = await this.serverRequestHandler(message.method, message.params || {})
        this.#send({ id: message.id, result })
      } catch (error) {
        this.#send({
          id: message.id,
          error: { code: -32601, message: error.message || String(error) },
        })
      }
      return
    }

    if (message.method) {
      this.emit('notification', message.method, message.params || {})
      this.emit(message.method, message.params || {})
    }
  }

  #onClose() {
    const error = new Error('Codex App Server connection closed')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.socket = null
    this.emit('close')
  }

  #emitError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }
}
