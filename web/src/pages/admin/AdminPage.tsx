import { useState, type FormEvent } from 'react';
import type { AuthState } from '../../../../shared/api.js';
import { post } from '../../api';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { navigate, usePath } from '../../router';
import { ApiKeysTab } from './ApiKeysTab';
import { LockedOrError } from '../AuthPages';
import { CodexTab } from './CodexTab';
import { OverviewTab } from './OverviewTab';
import { RequestsTab } from './RequestsTab';
import { SecurityTab, TransfersTab } from './LogTabs';
import { McpTab } from './McpTab';
import { SettingsTab } from './SettingsTab';

const TABS = ['overview', 'codex', 'requests', 'keys', 'mcp', 'files', 'security', 'settings'] as const;
type Tab = (typeof TABS)[number];

/** Keys never open the admin area: it needs the owner password and an authenticator code. */
function Unlock({ onAuth }: { onAuth: (s: AuthState) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAuth(await post<AuthState>('/api/auth/admin', { password, code: code.replace(/\s/g, '') }));
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-page">
      <form className="auth-card card" onSubmit={submit}>
        <h1>
          <Icon name="shield" /> {t('admin.unlock.title')}
        </h1>
        <p>{t('admin.unlock.body')}</p>
        <div className="field">
          <label htmlFor="admin-password">{t('login.password')}</label>
          <input id="admin-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="admin-code">{t('login.code')}</label>
          <input
            id="admin-code"
            className="otp-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, '').slice(0, 7))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{3}\s?\d{3}"
            required
          />
          <span className="hint">{t('login.codeHint')}</span>
        </div>
        <LockedOrError error={error} />
        <p />
        <button type="submit" className="btn primary" disabled={busy || !password || code.replace(/\s/g, '').length !== 6}>
          {t('admin.unlock.submit')}
        </button>
      </form>
    </div>
  );
}

export function AdminPage({ auth, onAuth }: { auth: AuthState; onAuth: (s: AuthState) => void }) {
  const { t } = useI18n();
  const path = usePath();
  const tab: Tab = (TABS as readonly string[]).includes(path.split('/')[2] ?? '') ? (path.split('/')[2] as Tab) : 'overview';
  // An admin call can report that the step-up expired; drop back to the unlock form.
  const [expired, setExpired] = useState(false);
  if (!auth.admin || expired) {
    return (
      <Unlock
        onAuth={(s) => {
          setExpired(false);
          onAuth(s);
        }}
      />
    );
  }
  const onAdminLost = () => setExpired(true);
  const labels: Record<Tab, string> = {
    overview: t('adminTab.overview'),
    codex: t('adminTab.codex'),
    requests: t('adminTab.requests'),
    keys: t('adminTab.keys'),
    mcp: t('adminTab.mcp'),
    files: t('adminTab.files'),
    security: t('adminTab.security'),
    settings: t('adminTab.settings'),
  };
  return (
    <main className="admin">
      <div className="admin-inner">
        <div className="tabs" role="tablist" aria-label={t('nav.admin')}>
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => navigate(k === 'overview' ? '/admin' : `/admin/${k}`)}>
              {labels[k]}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'overview' ? <OverviewTab onAdminLost={onAdminLost} /> : null}
          {tab === 'codex' ? <CodexTab onAdminLost={onAdminLost} /> : null}
          {tab === 'requests' ? <RequestsTab onAdminLost={onAdminLost} /> : null}
          {tab === 'keys' ? <ApiKeysTab onAdminLost={onAdminLost} /> : null}
          {tab === 'mcp' ? <McpTab onAdminLost={onAdminLost} /> : null}
          {tab === 'files' ? <TransfersTab onAdminLost={onAdminLost} /> : null}
          {tab === 'security' ? <SecurityTab onAdminLost={onAdminLost} /> : null}
          {tab === 'settings' ? <SettingsTab onAdminLost={onAdminLost} onAuth={onAuth} /> : null}
        </div>
      </div>
    </main>
  );
}
