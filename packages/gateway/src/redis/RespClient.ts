import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { RedisCommander } from '@hps/core-api';

/**
 * Minimal, dependency-free RESP2 client (redis:// and rediss://) with request pipelining,
 * AUTH/SELECT on connect and lazy reconnect. Enough for IUsageStore (GET/SET/INCRBY/DEL).
 */
export class RedisReplyError extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RespClient implements RedisCommander {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private readonly url: URL;

  constructor(
    url: string,
    private readonly opts: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {},
  ) {
    this.url = new URL(url);
    if (!['redis:', 'rediss:'].includes(this.url.protocol)) throw new Error('REDIS_URL must start with redis:// or rediss://');
  }

  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const port = Number(this.url.port || 6379);
    const host = this.url.hostname;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const sock = this.url.protocol === 'rediss:' ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
      const timer = setTimeout(() => sock.destroy(new Error('Redis connect timeout')), this.opts.connectTimeoutMs ?? 5000);
      sock.setNoDelay(true);
      sock.once(this.url.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        this.buf = Buffer.alloc(0);
        resolve(sock);
      });
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (e) => {
        clearTimeout(timer);
        this.fail(e);
        reject(e);
      });
      sock.on('close', () => {
        this.socket = null;
        this.fail(new Error('Redis connection closed'));
      });
    }).then(async (sock) => {
      this.connecting = null;
      const user = decodeURIComponent(this.url.username);
      const pass = decodeURIComponent(this.url.password);
      if (pass) await this.send(user ? ['AUTH', user, pass] : ['AUTH', pass]);
      const db = this.url.pathname.replace('/', '');
      if (db && db !== '0') await this.send(['SELECT', db]);
      return sock;
    }, (e) => {
      this.connecting = null;
      throw e;
    });
    return this.connecting;
  }

  private fail(e: Error) {
    while (this.queue.length) this.queue.shift()!.reject(e);
  }

  private send(args: (string | number)[]): Promise<unknown> {
    const sock = this.socket;
    if (!sock) return Promise.reject(new Error('Redis not connected'));
    const parts = [`*${args.length}\r\n`];
    for (const a of args) {
      const s = String(a);
      parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Redis ${String(args[0])} timeout`)), this.opts.commandTimeoutMs ?? 10_000);
      this.queue.push({ resolve: (v) => (clearTimeout(timeout), resolve(v)), reject: (e) => (clearTimeout(timeout), reject(e)) });
      sock.write(parts.join(''));
    });
  }

  async command(args: (string | number)[]): Promise<unknown> {
    await this.open();
    return this.send(args);
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const r = parseReply(this.buf, 0);
      if (!r) return;
      this.buf = this.buf.subarray(r.end);
      const p = this.queue.shift();
      if (!p) continue;
      if (r.value instanceof RedisReplyError) p.reject(r.value);
      else p.resolve(r.value);
    }
  }

  async quit() {
    if (!this.socket) return;
    await this.send(['QUIT']).catch(() => undefined);
    this.socket?.destroy();
    this.socket = null;
  }
}

/** Parses one RESP2 reply at `pos`; returns null when the buffer is incomplete. */
export function parseReply(buf: Buffer, pos: number): { value: unknown; end: number } | null {
  if (pos >= buf.length) return null;
  const nl = buf.indexOf('\r\n', pos);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[pos]!);
  const line = buf.toString('utf8', pos + 1, nl);
  const after = nl + 2;
  switch (type) {
    case '+':
      return { value: line, end: after };
    case '-':
      return { value: new RedisReplyError(line), end: after };
    case ':':
      return { value: Number(line), end: after };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, end: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString('utf8', after, after + len), end: after + len + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, end: after };
      const out: unknown[] = [];
      let p = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, p);
        if (!r) return null;
        out.push(r.value);
        p = r.end;
      }
      return { value: out, end: p };
    }
    default:
      throw new Error(`Unexpected RESP type ${type}`);
  }
}
