import http from 'node:http';
import net from 'node:net';

/** "::ffff:1.2.3.4" → "1.2.3.4" so IPv4 rules match IPv4-mapped addresses. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** Parse "10.0.0.0/8", "2001:db8::/32" or a bare address; null if invalid. */
export function parseCidr(raw: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [addr, bits, extra] = raw.trim().split('/');
  if (!addr || extra !== undefined) return null;
  const v = net.isIP(addr);
  if (v === 0) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) return null;
  return { address: addr, prefix, family: v === 4 ? 'ipv4' : 'ipv6' };
}

export function buildAllowlist(cidrs: readonly string[]): net.BlockList | null {
  if (cidrs.length === 0) return null;
  const list = new net.BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (p) list.addSubnet(p.address, p.prefix, p.family);
  }
  return list;
}

export function ipAllowed(list: net.BlockList | null, ip: string): boolean {
  if (!list) return true;
  const addr = normalizeIp(ip);
  const family = net.isIP(addr);
  if (family === 0) return false;
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

// ---- PROXY protocol (v1 text and v2 binary), as sent by `tailscale funnel --proxy-protocol` ----

const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const V1_PREFIX = Buffer.from('PROXY ', 'latin1');
const MAX_HEADER = 536;

export interface ProxyInfo {
  sourceAddress: string;
  sourcePort: number;
}

export type ProxyParse =
  | { kind: 'need-more' }
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'ok'; info: ProxyInfo | null; length: number };

function startsWithPartial(buf: Buffer, sig: Buffer): boolean {
  const n = Math.min(buf.length, sig.length);
  return buf.subarray(0, n).equals(sig.subarray(0, n));
}

function ipv6(buf: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

export function parseProxyHeader(buf: Buffer): ProxyParse {
  if (startsWithPartial(buf, V2_SIGNATURE)) {
    if (buf.length < 16) return { kind: 'need-more' };
    const verCmd = buf[12]!;
    if (verCmd >> 4 !== 2) return { kind: 'invalid' };
    const len = buf.readUInt16BE(14);
    if (16 + len > MAX_HEADER) return { kind: 'invalid' };
    if (buf.length < 16 + len) return { kind: 'need-more' };
    const total = 16 + len;
    if ((verCmd & 0x0f) === 0) return { kind: 'ok', info: null, length: total }; // LOCAL (health check)
    const family = buf[13]! >> 4;
    if (family === 1 && len >= 12) {
      const a = buf.subarray(16, 20);
      return { kind: 'ok', info: { sourceAddress: `${a[0]}.${a[1]}.${a[2]}.${a[3]}`, sourcePort: buf.readUInt16BE(24) }, length: total };
    }
    if (family === 2 && len >= 36) {
      return { kind: 'ok', info: { sourceAddress: ipv6(buf.subarray(16, 32)), sourcePort: buf.readUInt16BE(48) }, length: total };
    }
    return { kind: 'ok', info: null, length: total };
  }
  if (startsWithPartial(buf, V1_PREFIX)) {
    if (buf.length < V1_PREFIX.length) return { kind: 'need-more' };
    const end = buf.indexOf('\r\n');
    if (end === -1) return buf.length > 107 ? { kind: 'invalid' } : { kind: 'need-more' };
    const parts = buf.subarray(0, end).toString('latin1').split(' ');
    if (parts[1] === 'UNKNOWN') return { kind: 'ok', info: null, length: end + 2 };
    if (parts.length !== 6 || (parts[1] !== 'TCP4' && parts[1] !== 'TCP6') || net.isIP(parts[2]!) === 0) return { kind: 'invalid' };
    const port = Number(parts[4]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { kind: 'invalid' };
    return { kind: 'ok', info: { sourceAddress: parts[2]!, sourcePort: port }, length: end + 2 };
  }
  return { kind: 'none' };
}

const PROXIED = Symbol('proxiedAddress');

export function proxiedAddress(socket: net.Socket): ProxyInfo | undefined {
  return (socket as unknown as Record<symbol, ProxyInfo | undefined>)[PROXIED];
}

/**
 * A TCP front for an HTTP server that strips a PROXY protocol header and remembers the
 * client address it carries. Only bind it to loopback: the header is trusted as-is.
 */
export function proxyProtocolFront(target: http.Server, mode: 'optional' | 'required', timeoutMs = 5000): net.Server {
  const front = net.createServer((socket) => {
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const r = parseProxyHeader(buf);
      if (r.kind === 'need-more') {
        if (buf.length > MAX_HEADER) socket.destroy();
        return;
      }
      socket.removeListener('data', onData);
      socket.pause();
      clearTimeout(timer);
      if (r.kind === 'invalid' || (r.kind === 'none' && mode === 'required')) {
        socket.destroy();
        return;
      }
      if (r.kind === 'ok' && r.info) (socket as unknown as Record<symbol, ProxyInfo>)[PROXIED] = r.info;
      const rest = r.kind === 'ok' ? buf.subarray(r.length) : buf;
      if (rest.length) socket.unshift(rest);
      target.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });
  return front;
}
