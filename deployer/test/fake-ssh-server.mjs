// A pretend Linux server for the tests: an SSH server that answers only the commands the deploy
// program runs, the way a real server would. `node test/fake-ssh-server.mjs` runs one by hand.
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import ssh2 from 'ssh2';
import { untar } from '../scripts/tar.mjs';

const { Server, utils } = ssh2;
const CLI = '/usr/local/bin/codex-console';
export const FAKE_KEY = `cck_0123456789abcdef.${'A'.repeat(43)}`;

/**
 * An Ed25519 key pair for the tests. ssh2's generator drops a leading zero byte of the public key
 * (about 1 key in 256) and writes a key it cannot read back, so those are skipped.
 */
export function testKeyPair() {
  for (;;) {
    const keys = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(keys.private) instanceof Error)) return keys;
  }
}

/**
 * @param {{
 *   user?: string, password?: string, publicKey?: string,
 *   root?: boolean, sudo?: 'nopasswd' | 'password' | 'none', sudoPassword?: string,
 *   installed?: boolean, setUp?: boolean, checkExit?: number, installExit?: number, installDelayMs?: number,
 *   site?: string, hostKey?: string, port?: number, log?: boolean,
 * }} [opts]
 */
export async function startFakeServer(opts = {}) {
  const o = { user: 'root', password: 'server-pw', root: true, sudo: 'nopasswd', installed: false, setUp: false, checkExit: 0, installExit: 0, site: 'https://203.0.113.7', ...opts };
  const hostKey = o.hostKey ?? testKeyPair().private;
  const parsedHost = utils.parseKey(hostKey);
  const allowedKey = o.publicKey ? utils.parseKey(o.publicKey) : null;
  /** @type {{ installed: boolean, setUp: boolean, commands: string[], uploads: string[][], installers: string[], confirmed: number }} */
  const state = { installed: o.installed, setUp: o.setUp, commands: [], uploads: [], installers: [], confirmed: 0 };
  const sudoPw = o.sudoPassword ?? o.password;

  function run(command, stdin) {
    // Strip the sudo prefix the way sudo itself would: with -S it reads the password line first.
    let cmd = command;
    let input = stdin;
    if (cmd.startsWith("sudo -S -p '' ")) {
      cmd = cmd.slice("sudo -S -p '' ".length);
      const nl = input.indexOf('\n');
      if (o.sudo !== 'password' || nl === -1 || input.subarray(0, nl).toString() !== sudoPw) return { err: 'Sorry, try again.\n', code: 1 };
      input = input.subarray(nl + 1);
    } else if (cmd.startsWith('sudo -n ')) {
      if (o.sudo !== 'nopasswd') return { err: 'sudo: a password is required\n', code: 1 };
      cmd = cmd.slice('sudo -n '.length);
    }
    let m;
    if (cmd === 'id -u') return { out: o.root ? '0\n' : '1000\n' };
    if (cmd === 'command -v sudo') return o.sudo === 'none' ? { code: 1 } : { out: '/usr/bin/sudo\n' };
    if (cmd === 'true') return {};
    if ((m = /^mktemp (-d )?\/tmp\/codex-console-(check|upload)-XXXXXXXXXX$/.exec(cmd))) return { out: `/tmp/codex-console-${m[2]}-AbCdE12345\n` };
    if ((m = /^cat > (\/tmp\/codex-console-check-\w+)$/.exec(cmd))) {
      state.installers.push(input.toString());
      return {};
    }
    if ((m = /^bash \/tmp\/codex-console-check-\w+ --check (.*); s=\$\?; rm -f \S+; exit \$s$/.exec(cmd))) {
      return { out: `\n==> Checking the server\n    ✓ Ubuntu 24.04 (args: ${m[1]})\n`, code: o.checkExit };
    }
    if ((m = /^tar -xzf - -C (\/tmp\/codex-console-upload-\w+)$/.exec(cmd))) {
      try {
        state.uploads.push([...untar(gunzipSync(input))].map((f) => f.name));
        if (o.log) console.log(`  (received ${state.uploads.at(-1).length} files)`);
        return {};
      } catch {
        return { err: 'gzip: stdin: not in gzip format\n', code: 2 };
      }
    }
    if ((m = /^bash (\/tmp\/codex-console-upload-\w+)\/deploy\/install\.sh --src \1 (.*)$/.exec(cmd))) {
      const delay = o.installDelayMs ?? 0;
      if (o.installExit !== 0) return { out: '\n==> Installing system packages\n', err: '    x Stopped on an error (line 42)\n', code: o.installExit, delay };
      state.installed = true;
      const setupLine = state.setUp ? '' : `CODEX_CONSOLE_SETUP_URL=${o.site}/setup#token=first-link\n`;
      return { out: `\n==> Installing system packages\n    ✓ Release 20261101 (args: ${m[2]})\n\nCodex Console is ready\nCODEX_CONSOLE_URL=${o.site}\n${setupLine}`, delay };
    }
    if (/^rm -rf \/tmp\/codex-console-upload-\w+$/.test(cmd)) return {};
    if (cmd.startsWith("sh -c 'systemctl stop codex-console-guard.timer")) {
      state.confirmed++;
      return {};
    }
    if (cmd === `test -x ${CLI}`) return { code: state.installed ? 0 : 1 };
    if (cmd === `${CLI} setup --is-set-up`) return { code: state.setUp ? 0 : 1 };
    if ((m = /^\/usr\/local\/bin\/codex-console setup --new-key '([^']*)' --lang '(en|zh-CN)'$/.exec(cmd))) {
      if (!state.setUp) return { out: 'Run `npm run setup` (without options) first.\n', code: 1 };
      return { out: `API key for “${m[1]}” (shown only now, keep it somewhere safe):\n\n    ${FAKE_KEY}\n\nOpen ${o.site} on that device and paste the key. Nothing else to set up.\n` };
    }
    if (cmd === `${CLI} setup --setup-link`) return state.setUp ? { err: 'Setup is already complete.\n', code: 1 } : { out: `${o.site}/setup#token=new-link\n` };
    return { err: `sh: unknown command: ${cmd}\n`, code: 127 };
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.setNoDelay(true);
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.username !== o.user) return ctx.reject(['password', 'publickey']);
      if (ctx.method === 'password' && o.password && ctx.password === o.password) return ctx.accept();
      if (ctx.method === 'publickey' && allowedKey && ctx.key.algo === allowedKey.type && crypto.timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH())) {
        if (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        acceptSession().on('exec', (accept, _reject, info) => {
          const stream = accept();
          state.commands.push(info.command);
          if (o.log) console.log(`$ ${info.command}`);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const r = run(info.command, Buffer.concat(chunks));
            setTimeout(() => {
              if (r.out) stream.write(r.out);
              if (r.err) stream.stderr.write(r.err);
              stream.exit(r.code ?? 0);
              stream.end();
            }, r.delay ?? 0);
          });
        });
      });
    });
  });
  await new Promise((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, '')}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeServer({
    installExit: Number(process.env.INSTALL_EXIT ?? 0),
    port: Number(process.env.PORT ?? 0),
    installed: process.env.INSTALLED === '1',
    setUp: process.env.SET_UP === '1',
    log: true,
  });
  console.log(`Fake server on 127.0.0.1:${s.port} (user root, password server-pw), fingerprint ${s.fingerprint}`);
}
