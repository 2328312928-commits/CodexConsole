import { detectLang, translate, type Lang, type MessageKey, type Vars } from '../../shared/i18n/index.js';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../auth/passwords.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '../config.js';
import { qrTerminal } from '../lib/qr.js';
import { openStores } from '../runtime.js';
import { Aborted, Prompter } from './prompt.js';

interface Flags {
  lang?: Lang;
  resetPassword: boolean;
  resetTotp: boolean;
  revokeAll: boolean;
  pair?: string;
}

function parseFlags(argv: string[], t: (k: MessageKey, v?: Vars) => string): Flags {
  const flags: Flags = { resetPassword: false, resetTotp: false, revokeAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--reset-password') flags.resetPassword = true;
    else if (a === '--reset-totp') flags.resetTotp = true;
    else if (a === '--revoke-all') flags.revokeAll = true;
    else if (a === '--pair') flags.pair = argv[++i] ?? '';
    else if (a === '--lang') flags.lang = argv[++i] === 'zh-CN' ? 'zh-CN' : 'en';
    else {
      console.error(t('cli.unknownOption', { option: a }));
      console.error(t('cli.options'));
      process.exit(2);
    }
  }
  return flags;
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const langIdx = argv.indexOf('--lang');
  const lang: Lang =
    langIdx >= 0 ? (argv[langIdx + 1] === 'zh-CN' ? 'zh-CN' : 'en') : detectLang([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);
  const t = (k: MessageKey, v?: Vars) => translate(lang, k, v);
  const flags = parseFlags(argv, t);

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const stores = openStores(config);
  const prompt = new Prompter();
  const out = (s = '') => process.stdout.write(s + '\n');

  out(`\n== ${t('cli.title')} ==`);
  out(t('cli.dataDir', { path: config.dataDir }));
  out();

  const requireOwner = () => {
    if (!stores.owner.exists()) {
      out(t('cli.notSetUp'));
      process.exit(1);
    }
  };

  async function askNewPassword(): Promise<string> {
    for (;;) {
      const pw = await prompt.askHidden(t('cli.passwordPrompt', { min: MIN_PASSWORD_LENGTH }));
      if (passwordProblem(pw)) {
        out(t('cli.passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
        continue;
      }
      const again = await prompt.askHidden(t('cli.passwordConfirm'));
      if (again !== pw) {
        out(t('cli.passwordMismatch'));
        continue;
      }
      return pw;
    }
  }

  async function enrolTotp(): Promise<string | null> {
    const secret = generateTotpSecret();
    out(t('cli.totpIntro'));
    out(await qrTerminal(otpauthUri(secret)));
    out(t('cli.totpSecret', { secret: secret.replace(/(.{4})/g, '$1 ').trim() }));
    out();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await prompt.ask(t('cli.totpPrompt'));
      if (verifyTotp(secret, code, Date.now(), 0) !== null) return secret;
      out(t('cli.totpWrong'));
    }
    out(t('cli.totpFailed'));
    return null;
  }

  async function printPairing(name: string): Promise<void> {
    const { code } = stores.devices.create(name.slice(0, 60), null);
    const url = `${config.publicOrigin}/pair#code=${encodeURIComponent(code)}`;
    stores.audit.security('device_created', {}, { name, via: 'cli' });
    out();
    out(t('cli.pairingCode', { name }));
    out(`\n    ${code}\n`);
    out(t('cli.pairingUrl', { url }));
    out(t('cli.pairingQr'));
    out(await qrTerminal(url));
  }

  try {
    if (flags.revokeAll) {
      requireOwner();
      out(t('cli.revokedAll', { count: stores.logins.revokeAll(null) }));
    } else if (flags.pair !== undefined) {
      requireOwner();
      await printPairing(flags.pair.trim() || t('cli.deviceNameDefault'));
    } else if (flags.resetPassword) {
      requireOwner();
      await stores.owner.setPassword(await askNewPassword());
      stores.logins.revokeAll(null);
      stores.audit.security('settings_changed', {}, { change: 'password', via: 'cli' });
      out(t('cli.passwordChanged'));
    } else if (flags.resetTotp) {
      requireOwner();
      const secret = await enrolTotp();
      if (!secret) process.exit(1);
      stores.owner.setTotpSecret(secret);
      stores.logins.revokeAll(null);
      stores.audit.security('settings_changed', {}, { change: 'totp', via: 'cli' });
      out(t('cli.totpChanged'));
    } else if (stores.owner.exists()) {
      out(t('cli.alreadySetUp'));
      out(t('cli.options'));
    } else {
      const password = await askNewPassword();
      out();
      const secret = await enrolTotp();
      if (!secret) process.exit(1);
      await stores.owner.create(password, secret);
      stores.audit.security('setup_completed', {}, { via: 'cli' });
      const fallback = t('cli.deviceNameDefault');
      const name = (await prompt.ask(t('cli.deviceNamePrompt', { default: fallback }))).trim() || fallback;
      await printPairing(name);
      out(t('cli.done'));
      out(t('cli.nextSteps', { url: config.publicOrigin }));
    }
  } catch (err) {
    if (err instanceof Aborted) {
      out(t('cli.aborted'));
      process.exit(130);
    }
    throw err;
  } finally {
    prompt.close();
    stores.db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
