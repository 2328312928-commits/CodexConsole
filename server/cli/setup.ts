import { detectLang, translate, type Lang, type MessageKey, type Vars } from '../../shared/i18n/index.js';
import { consoleKeySettings } from '../auth/apiKeys.js';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../auth/passwords.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '../config.js';
import { qrTerminal } from '../lib/qr.js';
import { openStores } from '../runtime.js';
import { defaultFolderName } from '../services/workspace.js';
import { Aborted, Prompter } from './prompt.js';

interface Flags {
  lang?: Lang;
  resetPassword: boolean;
  resetTotp: boolean;
  signOutAll: boolean;
  listKeys: boolean;
  newKey?: string;
  revokeKey?: string;
}

function parseFlags(argv: string[], t: (k: MessageKey, v?: Vars) => string): Flags {
  const flags: Flags = { resetPassword: false, resetTotp: false, signOutAll: false, listKeys: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--reset-password') flags.resetPassword = true;
    else if (a === '--reset-totp') flags.resetTotp = true;
    else if (a === '--sign-out-all') flags.signOutAll = true;
    else if (a === '--list-keys') flags.listKeys = true;
    else if (a === '--new-key') flags.newKey = argv[++i] ?? '';
    else if (a === '--revoke-key') flags.revokeKey = argv[++i] ?? '';
    else if (a === '--lang') flags.lang = argv[++i] === 'zh-CN' ? 'zh-CN' : 'en';
    else if (a === '--is-set-up') continue;
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
  // For scripts (the server installer): exit 0 when setup is done, 1 when it is not.
  if (argv.includes('--is-set-up')) {
    const done = stores.owner.exists();
    stores.db.close();
    process.exit(done ? 0 : 1);
  }
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

  function issueKey(label: string): void {
    // A console-only key never needs its API folder; it is created if the key is ever given API scopes.
    const { key, secret } = stores.keys.create(consoleKeySettings(label), `api/${defaultFolderName(label)}`);
    stores.audit.security('api_key_created', { apiKeyId: key.id }, { label: key.label, consoleAccess: 'full', via: 'cli' });
    out();
    out(t('cli.keyCreated', { label: key.label }));
    out(`\n    ${secret}\n`);
    out(t('cli.keyUse', { url: config.publicOrigin }));
  }

  try {
    if (flags.signOutAll) {
      requireOwner();
      out(t('cli.revokedAll', { count: stores.logins.revokeAll(null) }));
    } else if (flags.newKey !== undefined) {
      requireOwner();
      issueKey(flags.newKey.trim() || t('cli.keyLabelDefault'));
    } else if (flags.listKeys) {
      const keys = stores.keys.list();
      if (keys.length === 0) out(t('cli.keyListEmpty'));
      for (const k of keys) {
        const status = t(`keys.status.${stores.keys.status(k)}`);
        const access = t(`keys.console.${k.consoleAccess}`);
        const used = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString().slice(0, 16).replace('T', ' ') : t('common.never');
        out(`  ${k.id}  ${status.padEnd(8)}  ${access.padEnd(14)}  ${used.padEnd(16)}  ${k.label}`);
      }
    } else if (flags.revokeKey !== undefined) {
      const id = flags.revokeKey.trim();
      if (!stores.keys.get(id)) {
        out(t('cli.keyNotFound', { id }));
        process.exit(1);
      }
      stores.keys.revoke(id);
      const ended = stores.logins.endForKey(id);
      stores.audit.security('api_key_revoked', { apiKeyId: id }, { via: 'cli', signedOut: ended });
      out(t('cli.keyRevoked', { id, count: ended }));
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
      out(t('cli.intro'));
      out();
      const password = await askNewPassword();
      out();
      const secret = await enrolTotp();
      if (!secret) process.exit(1);
      await stores.owner.create(password, secret);
      stores.audit.security('setup_completed', {}, { via: 'cli' });
      const fallback = t('cli.keyLabelDefault');
      const label = (await prompt.ask(t('cli.keyLabelPrompt', { default: fallback }))).trim() || fallback;
      issueKey(label);
      out();
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
