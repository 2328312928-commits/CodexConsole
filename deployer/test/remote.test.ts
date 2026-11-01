import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { tar } from '../scripts/tar.mjs';
import {
  checkServer,
  deploy,
  HostKeyChangedError,
  installerArgs,
  newSetupLink,
  q,
  recoveryKey,
  RemoteError,
  UnknownHostError,
  type Connection,
  type DeployStep,
  type Site,
} from '../src/remote.js';
import { FAKE_KEY, startFakeServer, testKeyPair } from './fake-ssh-server.mjs';

const site: Site = { mode: 'ip', lang: 'en' };
const bundle = gzipSync(
  tar([
    { name: 'package.json', data: Buffer.from('{}') },
    { name: 'deploy/install.sh', data: Buffer.from('#!/usr/bin/env bash\n') },
  ]),
);

class Known {
  map = new Map<string, string>();
  get(hostPort: string) {
    return this.map.get(hostPort);
  }
}

const servers: { close(): Promise<unknown> }[] = [];
async function fake(opts: Parameters<typeof startFakeServer>[0] = {}) {
  const server = await startFakeServer(opts);
  servers.push(server);
  const known = new Known();
  known.map.set(`127.0.0.1:${server.port}`, server.fingerprint);
  return { server, known };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('deploy over SSH', () => {
  it('asks before trusting a new server, then installs and reports where the console is', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const known = new Known();
    const conn: Connection = { host: '127.0.0.1', port: server.port, username: 'root', password: 'server-pw' };

    const first = await deploy(conn, known, bundle, site, () => undefined).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(UnknownHostError);
    expect((first as UnknownHostError).fingerprint).toBe(server.fingerprint);
    expect((first as UnknownHostError).hostPort).toBe(`127.0.0.1:${server.port}`);
    expect(server.state.commands).toEqual([]); // nothing ran on an unconfirmed server

    known.map.set(`127.0.0.1:${server.port}`, server.fingerprint);
    const lines: string[] = [];
    const steps: DeployStep[] = [];
    const r = await deploy(conn, known, bundle, site, (l) => lines.push(l), (s) => steps.push(s));
    expect(r).toEqual({ ok: true, consoleUrl: 'https://203.0.113.7', setupUrl: 'https://203.0.113.7/setup#token=first-link', sshConfirmed: true });
    expect(steps).toEqual(['connect', 'upload', 'install', 'confirm']);
    expect(lines).toContain('Codex Console is ready');
    expect(lines.join('\n')).not.toContain('CODEX_CONSOLE_'); // the machine-readable lines stay out of the log
    expect(server.state.uploads[0]).toEqual(['package.json', 'deploy/install.sh']);
    const install = server.state.commands.find((c) => c.includes('/deploy/install.sh'));
    expect(install).toBe(`bash /tmp/codex-console-upload-AbCdE12345/deploy/install.sh --src /tmp/codex-console-upload-AbCdE12345 '--ip' '127.0.0.1' '--ssh-port' '${server.port}' '--lang' 'en'`);
    expect(server.state.confirmed).toBe(1);
  });

  it('refuses a server whose key is not the one trusted before', async () => {
    const { server, known } = await fake();
    known.map.set(`127.0.0.1:${server.port}`, 'SHA256:somethingElse');
    const err = await deploy({ host: '127.0.0.1', port: server.port, username: 'root', password: 'server-pw' }, known, bundle, site, () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostKeyChangedError);
    expect((err as HostKeyChangedError).fingerprint).toBe(server.fingerprint);
    expect(server.state.commands).toEqual([]);
  });

  it('reports a wrong password as an authentication failure', async () => {
    const { server, known } = await fake();
    const err = (await deploy({ host: '127.0.0.1', port: server.port, username: 'root', password: 'wrong' }, known, bundle, site, () => undefined).catch((e: unknown) => e)) as { level?: string };
    expect(err.level).toBe('client-authentication');
  });

  it('runs as root through sudo with the password, which never reaches the installer', async () => {
    const { server, known } = await fake({ root: false, user: 'ubuntu', sudo: 'password' });
    const conn: Connection = { host: '127.0.0.1', port: server.port, username: 'ubuntu', password: 'server-pw' };
    const r = await deploy(conn, known, bundle, site, () => undefined);
    expect(r.ok).toBe(true);
    expect(server.state.commands).toContain("sudo -S -p '' true");
    expect(server.state.commands.some((c) => c.startsWith("sudo -S -p '' bash /tmp/codex-console-upload-"))).toBe(true);

    const wrong = await deploy({ ...conn, sudoPassword: 'nope' }, known, bundle, site, () => undefined).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(RemoteError);
    expect((wrong as RemoteError).code).toBe('sudo_failed');
  });

  it('signs in with a key, and asks for a sudo password only when sudo needs one', async () => {
    const keys = testKeyPair();
    const { server, known } = await fake({ root: false, user: 'ubuntu', sudo: 'password', password: undefined, sudoPassword: 'sudo-pw', publicKey: keys.public });
    const conn: Connection = { host: '127.0.0.1', port: server.port, username: 'ubuntu', privateKey: keys.private };
    const missing = await deploy(conn, known, bundle, site, () => undefined).catch((e: unknown) => e);
    expect((missing as RemoteError).code).toBe('sudo_password');
    expect((await deploy({ ...conn, sudoPassword: 'sudo-pw' }, known, bundle, site, () => undefined)).ok).toBe(true);

    const nopasswd = await fake({ root: false, user: 'ubuntu', sudo: 'nopasswd', password: undefined, publicKey: keys.public });
    const r = await deploy({ ...conn, port: nopasswd.server.port }, nopasswd.known, bundle, site, () => undefined);
    expect(r.ok).toBe(true);
    expect(nopasswd.server.state.commands.some((c) => c.startsWith('sudo -n bash /tmp/codex-console-upload-'))).toBe(true);
  });

  it('reports a failed install, cleans up the upload and still confirms SSH', async () => {
    const { server, known } = await fake({ installExit: 1 });
    const lines: string[] = [];
    const r = await deploy({ host: '127.0.0.1', port: server.port, username: 'root', password: 'server-pw' }, known, bundle, site, (l) => lines.push(l));
    expect(r).toEqual({ ok: false, consoleUrl: null, setupUrl: null, sshConfirmed: true });
    expect(lines.join('\n')).toContain('Stopped on an error');
    expect(server.state.commands).toContain('rm -rf /tmp/codex-console-upload-AbCdE12345');
  });
});

describe('the other tasks', () => {
  const conn = (port: number): Connection => ({ host: '127.0.0.1', port, username: 'root', password: 'server-pw' });

  it('checks the server with the installer and changes nothing', async () => {
    const { server, known } = await fake();
    const lines: string[] = [];
    expect(await checkServer(conn(server.port), known, '#!/usr/bin/env bash\necho check\n', site, (l) => lines.push(l))).toBe(true);
    expect(server.state.installers).toEqual(['#!/usr/bin/env bash\necho check\n']);
    expect(lines.join('\n')).toContain('Checking the server');
    expect(server.state.uploads).toEqual([]);

    const failing = await fake({ checkExit: 1 });
    expect(await checkServer(conn(failing.server.port), failing.known, '#!/bin/sh\n', site, () => undefined)).toBe(false);
  });

  it('gives a new setup link before setup, and a recovery key after it', async () => {
    const empty = await fake();
    expect(((await newSetupLink(conn(empty.server.port), empty.known).catch((e: unknown) => e)) as RemoteError).code).toBe('not_installed');

    const { server, known } = await fake({ installed: true });
    expect(await newSetupLink(conn(server.port), known)).toBe('https://203.0.113.7/setup#token=new-link');
    expect(((await recoveryKey(conn(server.port), known, 'Laptop', 'en').catch((e: unknown) => e)) as RemoteError).code).toBe('not_set_up');

    server.state.setUp = true;
    expect(await recoveryKey(conn(server.port), known, 'Laptop', 'en')).toEqual({ key: FAKE_KEY, consoleUrl: 'https://203.0.113.7' });
    expect(server.state.commands).toContain("/usr/local/bin/codex-console setup --new-key 'Laptop' --lang 'en'");
    expect(((await newSetupLink(conn(server.port), known).catch((e: unknown) => e)) as RemoteError).code).toBe('already_set_up');
  });
});

describe('helpers', () => {
  it('quotes words for the remote shell', () => {
    expect(q('plain')).toBe(`'plain'`);
    expect(q(`it's; rm -rf /`)).toBe(`'it'\\''s; rm -rf /'`);
  });

  it('builds the installer arguments for a domain', async () => {
    const args = await installerArgs({ host: '203.0.113.7', port: 2222, username: 'root' }, { mode: 'domain', domain: 'console.example.com', email: 'me@example.com', lang: 'zh-CN' });
    expect(args).toEqual(['--domain', 'console.example.com', '--email', 'me@example.com', '--ssh-port', '2222', '--lang', 'zh-CN']);
  });
});
