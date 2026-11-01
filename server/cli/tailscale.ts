import { detectLang, translate, type Lang, type MessageKey, type Vars } from '../../shared/i18n/index.js';
import { loadDotEnv } from '../config.js';
import { openInBrowser, startWithTailscale, TailscaleModeError } from '../tailscale.js';

// `npm run tailscale` (or "Start Codex Console" on Windows): the console on this computer, with a fixed
// https address from Tailscale. Public through Funnel; --tailnet-only keeps it to your own devices.
//   --tailnet-only   only your Tailscale devices can open it (Serve instead of Funnel)
//   --no-open        do not open the setup page in this computer's browser
//   --no-check       do not wait for the address to answer
//   --lang en|zh-CN  language for messages

function pickLang(argv: string[]): Lang {
  const i = argv.indexOf('--lang');
  if (i >= 0) return argv[i + 1] === 'zh-CN' ? 'zh-CN' : 'en';
  // Windows sets no LANG: fall back to the system's locale.
  return detectLang([process.env.CC_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale]);
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const lang = pickLang(argv);
  const t = (k: MessageKey, v?: Vars) => translate(lang, k, v);
  const out = (s = '') => process.stdout.write(`${s}\n`);
  const open = argv.includes('--no-open') ? undefined : openInBrowser;

  out(t('tailscale.title'));
  out();
  let mode;
  try {
    mode = await startWithTailscale({ lang, out, open, funnel: !argv.includes('--tailnet-only'), check: !argv.includes('--no-check') });
  } catch (err) {
    process.stderr.write(`\n${err instanceof TailscaleModeError ? err.message : `${t('tailscale.failed')} ${(err as Error).message}`}\n`);
    process.exit(1);
  }

  const rule = '='.repeat(Math.min(72, mode.origin.length + 12));
  out();
  out(rule);
  out(`  ${t(mode.funnel ? 'tailscale.readyPublic' : 'tailscale.ready')}`);
  out();
  out(`      ${mode.origin}`);
  out();
  out(`  ${t(mode.funnel ? 'tailscale.anyDevice' : 'tailscale.otherDevices')}`);
  if (mode.funnel) out(`  ${t('tailscale.publicNote')}`);
  out(rule);
  // Each start makes a new setup link while there is no owner account: only this window shows it.
  const setup = mode.console.newSetupLink();
  if (setup) {
    out();
    out(t('tailscale.setupFirst'));
    out(`    ${setup}`);
    open?.(setup);
  } else {
    out(t('tailscale.keys'));
  }
  out();
  out(t('tailscale.keepOpen'));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    out(t('tailscale.stopping'));
    await mode.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // Closing the window on Windows.
  process.on('SIGHUP', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
