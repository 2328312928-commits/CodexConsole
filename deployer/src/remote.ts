import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';

/** How to reach the server. Passwords and keys live only in memory, for one action. */
export interface Connection {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** For sudo, when the SSH user is not root and its sudo password is not the login password. */
  sudoPassword?: string;
}

/** Where the console will be reachable. */
export interface Site {
  mode: 'ip' | 'domain';
  domain?: string;
  email?: string;
  lang: 'en' | 'zh-CN';
}

export interface KnownHosts {
  get(hostPort: string): string | undefined;
}

/** First connection to this server: the owner must confirm its fingerprint. */
export class UnknownHostError extends Error {
  constructor(
    readonly hostPort: string,
    readonly fingerprint: string,
  ) {
    super('unknown_host');
  }
}

/** The server's key is not the one trusted before: possibly not your server at all. */
export class HostKeyChangedError extends Error {
  constructor(
    readonly hostPort: string,
    readonly fingerprint: string,
  ) {
    super('host_key_changed');
  }
}

export type RemoteErrorCode =
  | 'upload_failed'
  | 'no_sudo'
  | 'sudo_password'
  | 'sudo_failed'
  | 'bad_answer'
  | 'unknown_server'
  | 'not_installed'
  | 'not_set_up'
  | 'already_set_up';

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    readonly detail = '',
  ) {
    super(code);
  }
}

/** The console's command on the server, installed by install.sh. */
const CLI = '/usr/local/bin/codex-console';

/** OpenSSH-style fingerprint of a host key, as `ssh-keygen -lf` shows it. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Quote one word for the remote shell (POSIX sh, whatever the login shell is). */
export function q(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function connect(conn: Connection, known: KnownHosts, timeoutMs = 20_000): Promise<Client> {
  const hostPort = `${conn.host}:${conn.port}`;
  const expected = known.get(hostPort);
  let seen: string | null = null;
  const client = new Client();
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve(client));
    client.once('error', (err) => {
      if (seen !== null && expected === undefined) reject(new UnknownHostError(hostPort, seen));
      else if (seen !== null && seen !== expected) reject(new HostKeyChangedError(hostPort, seen));
      else reject(err);
    });
    // A server that hangs up before saying why (once ready, this changes nothing).
    client.once('close', () => reject(Object.assign(new Error('Connection closed'), { level: 'client-socket' })));
    if (conn.password) {
      // Some servers take the password only through keyboard-interactive.
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => conn.password!)));
    }
    const cfg: ConnectConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return seen === expected;
      },
      ...(conn.privateKey ? { privateKey: conn.privateKey, passphrase: conn.passphrase || undefined } : {}),
      ...(conn.password ? { password: conn.password, tryKeyboard: true } : {}),
    };
    client.connect(cfg);
    // Many small requests, one after another: without this each waits on TCP's delayed acknowledgement.
    client.setNoDelay(true);
  });
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one command; `onLine` gets its output line by line as it comes. */
export function exec(client: Client, command: string, opts: { stdin?: Buffer | string; onLine?: (line: string) => void } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const partial = { out: '', err: '' };
      const feed = (which: 'out' | 'err', text: string) => {
        if (!opts.onLine) return;
        partial[which] += text;
        let nl: number;
        while ((nl = partial[which].indexOf('\n')) !== -1) {
          opts.onLine(partial[which].slice(0, nl).replace(/\r$/, ''));
          partial[which] = partial[which].slice(nl + 1);
        }
      };
      stream.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        stdout += s;
        feed('out', s);
      });
      stream.stderr.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        stderr += s;
        feed('err', s);
      });
      stream.on('close', (code: number | null) => {
        for (const rest of [partial.out, partial.err]) if (rest && opts.onLine) opts.onLine(rest);
        resolve({ code: code ?? null, stdout, stderr });
      });
      stream.end(opts.stdin ?? '');
    });
  });
}

interface Sudo {
  prefix: string;
  stdin?: string;
}

/** How to run things as root on this server: directly, or through sudo (with the password on stdin). */
export async function privileges(client: Client, conn: Connection): Promise<Sudo> {
  if ((await exec(client, 'id -u')).stdout.trim() === '0') return { prefix: '' };
  if ((await exec(client, 'command -v sudo')).code !== 0) throw new RemoteError('no_sudo');
  // Passwordless sudo first, so a password is never left over on a command's input.
  if ((await exec(client, 'sudo -n true')).code === 0) return { prefix: 'sudo -n ' };
  const pw = conn.sudoPassword || conn.password;
  if (!pw) throw new RemoteError('sudo_password');
  const stdin = `${pw}\n`;
  if ((await exec(client, "sudo -S -p '' true", { stdin })).code !== 0) throw new RemoteError('sudo_failed');
  return { prefix: "sudo -S -p '' ", stdin };
}

/** A fresh temporary path on the server; mktemp's random name means nobody can prepare it. */
async function remoteTemp(client: Client, kind: 'check' | 'upload'): Promise<string> {
  const path = (await exec(client, `mktemp ${kind === 'upload' ? '-d ' : ''}/tmp/codex-console-${kind}-XXXXXXXXXX`)).stdout.trim();
  if (!new RegExp(`^/tmp/codex-console-${kind}-[A-Za-z0-9]{10}$`).test(path)) throw new RemoteError('bad_answer', path);
  return path;
}

/** The installer's arguments for this server and address. */
export async function installerArgs(conn: Connection, site: Site): Promise<string[]> {
  const args: string[] = [];
  if (site.mode === 'domain') args.push('--domain', site.domain ?? '');
  else {
    // A certificate for the server's public IPv4 address.
    const ip = isIPv4(conn.host) ? conn.host : await lookup(conn.host, { family: 4 }).then((r) => r.address, () => '');
    if (!ip) throw new RemoteError('unknown_server', conn.host);
    args.push('--ip', ip);
  }
  if (site.email) args.push('--email', site.email);
  args.push('--ssh-port', String(conn.port), '--lang', site.lang);
  return args;
}

/** Look at the server without changing anything (`install.sh --check`). */
export async function checkServer(conn: Connection, known: KnownHosts, installer: string, site: Site, onLine: (line: string) => void): Promise<boolean> {
  const client = await connect(conn, known);
  try {
    const sudo = await privileges(client, conn);
    const args = (await installerArgs(conn, site)).map(q).join(' ');
    const file = await remoteTemp(client, 'check');
    await exec(client, `cat > ${file}`, { stdin: installer });
    const r = await exec(client, `${sudo.prefix}bash ${file} --check ${args}; s=$?; rm -f ${file}; exit $s`, { stdin: sudo.stdin, onLine });
    return r.code === 0;
  } finally {
    client.end();
  }
}

export interface DeployResult {
  ok: boolean;
  consoleUrl: string | null;
  setupUrl: string | null;
  /** A second, new SSH login worked after the firewall changes (and stopped their safety timer). */
  sshConfirmed: boolean;
}

export type DeployStep = 'connect' | 'upload' | 'install' | 'confirm';

/** Copy the console to the server and install or update it. */
export async function deploy(
  conn: Connection,
  known: KnownHosts,
  bundle: Buffer,
  site: Site,
  onLine: (line: string) => void,
  onStep: (step: DeployStep) => void = () => undefined,
): Promise<DeployResult> {
  onStep('connect');
  const client = await connect(conn, known);
  let consoleUrl: string | null = null;
  let setupUrl: string | null = null;
  let code: number | null = null;
  try {
    const sudo = await privileges(client, conn);
    const args = (await installerArgs(conn, site)).map(q).join(' ');
    const dir = await remoteTemp(client, 'upload');
    onStep('upload');
    const up = await exec(client, `tar -xzf - -C ${dir}`, { stdin: bundle });
    if (up.code !== 0) {
      await exec(client, `rm -rf ${dir}`);
      throw new RemoteError('upload_failed', up.stderr.slice(0, 500));
    }
    onStep('install');
    const r = await exec(client, `${sudo.prefix}bash ${dir}/deploy/install.sh --src ${dir} ${args}`, {
      stdin: sudo.stdin,
      onLine: (line) => {
        // The installer reports where the console is with these two lines.
        const m = /^CODEX_CONSOLE_(URL|SETUP_URL)=(https:\/\/\S+)$/.exec(line);
        if (!m) return onLine(line);
        if (m[1] === 'URL') consoleUrl = m[2]!;
        else setupUrl = m[2]!;
      },
    });
    code = r.code;
    // The installer removes its upload when it finishes; after a failure that is left to us.
    if (code !== 0) await exec(client, `${sudo.prefix}rm -rf ${dir}`, { stdin: sudo.stdin }).catch(() => undefined);
  } finally {
    client.end();
  }
  // Like deploy.sh: a new SSH login keeps the firewall changes, even after a failed install.
  onStep('confirm');
  const sshConfirmed = await confirmSsh(conn, known);
  return { ok: code === 0, consoleUrl, setupUrl, sshConfirmed };
}

/** A new connection proves SSH still works after the firewall changes, and stops the timer that would undo them. */
export async function confirmSsh(conn: Connection, known: KnownHosts): Promise<boolean> {
  try {
    const client = await connect(conn, known);
    try {
      const sudo = await privileges(client, conn);
      const r = await exec(client, `${sudo.prefix}sh -c 'systemctl stop codex-console-guard.timer 2>/dev/null; ! systemctl is-active --quiet codex-console-guard.timer'`, { stdin: sudo.stdin });
      return r.code === 0;
    } finally {
      client.end();
    }
  } catch {
    return false;
  }
}

/** Whether the owner account exists yet (`codex-console setup --is-set-up`). */
async function isSetUp(client: Client, sudo: Sudo): Promise<boolean> {
  if ((await exec(client, `test -x ${CLI}`)).code !== 0) throw new RemoteError('not_installed');
  const r = await exec(client, `${sudo.prefix}${CLI} setup --is-set-up`, { stdin: sudo.stdin });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new RemoteError('bad_answer', (r.stderr || r.stdout).slice(0, 500));
}

/** A new full-console key, for when every key is lost (`codex-console setup --new-key`), and where to use it. */
export async function recoveryKey(conn: Connection, known: KnownHosts, name: string, lang: Site['lang']): Promise<{ key: string; consoleUrl: string | null }> {
  const client = await connect(conn, known);
  try {
    const sudo = await privileges(client, conn);
    if (!(await isSetUp(client, sudo))) throw new RemoteError('not_set_up');
    const r = await exec(client, `${sudo.prefix}${CLI} setup --new-key ${q(name.slice(0, 60))} --lang ${q(lang)}`, { stdin: sudo.stdin });
    const key = /cck_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}/.exec(r.stdout)?.[0];
    if (!key) throw new RemoteError('bad_answer', (r.stderr || r.stdout).slice(0, 500));
    return { key, consoleUrl: /https:\/\/[^\s'"“”]+/.exec(r.stdout)?.[0] ?? null };
  } finally {
    client.end();
  }
}

/** A new one-time setup link, while setup is not finished (`codex-console setup --setup-link`). */
export async function newSetupLink(conn: Connection, known: KnownHosts): Promise<string> {
  const client = await connect(conn, known);
  try {
    const sudo = await privileges(client, conn);
    if (await isSetUp(client, sudo)) throw new RemoteError('already_set_up');
    const r = await exec(client, `${sudo.prefix}${CLI} setup --setup-link`, { stdin: sudo.stdin });
    const url = r.stdout.trim().split('\n').pop() ?? '';
    if (r.code !== 0 || !/^https:\/\/\S+\/setup#token=[A-Za-z0-9_-]+$/.test(url)) throw new RemoteError('bad_answer', (r.stderr || r.stdout).slice(0, 500));
    return url;
  } finally {
    client.end();
  }
}
