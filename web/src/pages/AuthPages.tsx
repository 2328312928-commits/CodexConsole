import { useState, type FormEvent } from 'react';
import type { AuthState } from '../../../shared/api.js';
import { ApiFailure, post } from '../api';
import { ErrorAlert } from '../components/ui';
import { fmtDuration } from '../format';
import { useI18n } from '../i18n';
import { Icon } from '../icons';

export function SetupPage() {
  const { t } = useI18n();
  return (
    <div className="auth-card card">
      <h1>{t('setup.title')}</h1>
      <p>{t('setup.body')}</p>
      <pre className="output">npm run setup</pre>
      <p className="muted" style={{ marginTop: 12 }}>
        {t('setup.after')}
      </p>
    </div>
  );
}

/** Too many failed attempts from here: say how long to wait instead of a generic error. */
export function LockedOrError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (error instanceof ApiFailure && error.code === 'login_locked' && error.retryAfterSec) {
    return (
      <div className="alert error" role="alert">
        <Icon name="lock" />
        {t('login.lockedFor', { time: fmtDuration(t, error.retryAfterSec * 1000) })}
      </div>
    );
  }
  return <ErrorAlert error={error} />;
}

/** The only thing a browser needs: one of your API keys. */
export function SignInPage({ onSignedIn }: { onSignedIn: (state: AuthState) => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await post<AuthState>('/api/auth/key', { key: key.trim() }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="auth-card card" onSubmit={submit}>
      <h1>{t('signin.title')}</h1>
      <div className="field">
        <label htmlFor="signin-key">{t('signin.key')}</label>
        <input
          id="signin-key"
          className="mono"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus
        />
      </div>
      <LockedOrError error={error} />
      <p />
      <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
        <Icon name="key" size={16} />
        {t('signin.submit')}
      </button>
    </form>
  );
}
