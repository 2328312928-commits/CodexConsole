import type { AuthState } from '../../../shared/api.js';
import { limitSeverity, useCodexStatus } from '../codexStatus';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { navigate, usePath } from '../router';
import { LangSwitch } from './ui';

function CodexPill() {
  const { t } = useI18n();
  const { status } = useCodexStatus();
  if (!status) return null;
  const tone = status.state !== 'ready' ? 'bad' : status.signedIn ? 'good' : 'warn';
  const label = status.state !== 'ready' ? t(`codex.state.${status.state}`) : status.signedIn ? t('codex.state.ready') : t('overview.accountNone');
  const primary = status.rateLimits?.primary;
  return (
    <span className="status-pill" title={status.version ? `codex ${status.version}` : undefined}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      <span className="hide-mobile">{t('codex.statusLabel')}</span> {label}
      {primary ? (
        <span className={`mini-meter hide-mobile ${limitSeverity(primary.usedPercent)}`} title={t('codex.limits')}>
          <span className="m-track">
            <span className="m-fill" style={{ width: `${Math.min(100, primary.usedPercent)}%` }} />
          </span>
          {Math.round(primary.usedPercent)}%
        </span>
      ) : null}
    </span>
  );
}

export function Topbar({ auth, onSignOut }: { auth: AuthState; onSignOut?: () => void }) {
  const { t } = useI18n();
  const path = usePath();
  const loggedIn = auth.loggedIn && Boolean(onSignOut);
  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };
  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={loggedIn ? go('/') : undefined}>
        <span className="brand-mark">
          <Icon name="terminal" size={16} />
        </span>
        <span className="name">{t('app.name')}</span>
      </a>
      {loggedIn ? (
        <nav className="topnav" aria-label={t('nav.menu')}>
          <a href="/" onClick={go('/')} aria-current={!path.startsWith('/admin') ? 'page' : undefined}>
            {t('nav.console')}
          </a>
          <a href="/admin" onClick={go('/admin')} aria-current={path.startsWith('/admin') ? 'page' : undefined}>
            {t('nav.admin')}
          </a>
        </nav>
      ) : null}
      <span className="spacer" />
      {loggedIn ? <CodexPill /> : null}
      <LangSwitch />
      {loggedIn ? (
        <button type="button" className="btn ghost small" onClick={onSignOut} aria-label={t('nav.signOut')} title={t('nav.signOut')}>
          <Icon name="logout" size={16} />
          <span className="hide-mobile">{t('nav.signOut')}</span>
        </button>
      ) : null}
    </header>
  );
}
