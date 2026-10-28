import { EventEmitter } from 'node:events';

export type RpcId = string | number;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface RpcPeerEvents {
  notification: [method: string, params: unknown];
  request: [id: RpcId, method: string, params: unknown];
  protocolError: [line: string];
}

/**
 * JSON-RPC over newline-delimited JSON, as spoken by `codex app-server`
 * (messages omit the "jsonrpc" field).
 */
export class RpcPeer extends EventEmitter<RpcPeerEvents> {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private closed = false;

  constructor(private readonly write: (line: string) => void) {
    super();
  }

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: RpcId; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit('protocolError', trimmed.slice(0, 500));
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) this.emit('request', msg.id, msg.method, msg.params);
      else this.emit('notification', msg.method, msg.params);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code ?? -32000, msg.error.message ?? 'Unknown error', msg.error.data));
    else p.resolve(msg.result);
  }

  request<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(-32099, 'Codex connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32098, `Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** Reject everything in flight; further requests fail immediately. */
  close(reason = 'Codex connection closed'): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(-32099, reason));
      this.pending.delete(id);
    }
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    this.write(JSON.stringify(msg) + '\n');
  }
}
