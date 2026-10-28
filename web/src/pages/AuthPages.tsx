import { useEffect, useState, type FormEvent } from 'react';
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

export function PairPage({ onPaired }: { onPaired: (state: AuthState) => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // Pairing links carry the code in the #fragment, which never reaches the server logs.
    const m = /code=([^&]+)/.exec(location.hash);
    if (m) {
      setCode(decodeURIComponent(m[1]!));
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onPaired(await post<AuthState>('/api/auth/pair', { code: code.trim() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-card card" onSubmit={submit}>
      <h1>{t('pair.title')}</h1>
      <p>{t('pair.body')}</p>
      <div className="field">
        <label htmlFor="pair-code">{t('pair.code')}</label>
        <input
          id="pair-code"
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          required
          autoFocus
        />
      </div>
      <ErrorAlert error={error} />
      <p />
      <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
        <Icon name="key" size={16} />
        {t('pair.submit')}
      </button>
    </form>
  );
}

export function LoginPage({ auth, onLoggedIn }: { auth: AuthState; onLoggedIn: (state: AuthState) => void }) {
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
      onLoggedIn(await post<AuthState>('/api/auth/login', { password, code: code.replace(/\s/g, '') }));
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const locked = error instanceof ApiFailure && error.code === 'login_locked' && error.retryAfterSec;
  return (
    <form className="auth-card card" onSubmit={submit}>
      <h1>{t('login.title')}</h1>
      <p>{t('login.device', { name: auth.device?.name ?? '' })}</p>
      <div className="field">
        <label htmlFor="login-password">{t('login.password')}</label>
        <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="login-code">{t('login.code')}</label>
        <input
          id="login-code"
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
      {locked ? (
        <div className="alert error" role="alert">
          <Icon name="lock" />
          {t('login.lockedFor', { time: fmtDuration(t, (error as ApiFailure).retryAfterSec! * 1000) })}
        </div>
      ) : (
        <ErrorAlert error={error} />
      )}
      <p />
      <button type="submit" className="btn primary" disabled={busy || !password || code.replace(/\s/g, '').length !== 6}>
        {t('login.submit')}
      </button>
    </form>
  );
}
