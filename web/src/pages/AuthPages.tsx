import { useEffect, useState, type FormEvent } from 'react';
import type { AuthState } from '../../../shared/api.js';
import { ApiFailure, post } from '../api';
import { CopyButton, ErrorAlert } from '../components/ui';
import { fmtDuration } from '../format';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { navigate } from '../router';

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/**
 * First-time setup in the browser, from the one-time link the deploy program (or the installer)
 * gives you: admin password, authenticator, and a first key that signs this browser in.
 */
export function SetupWizard({ onDone }: { onDone: (state: AuthState) => void }) {
  const { t } = useI18n();
  const [token] = useState(() => /token=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? '');
  const [authenticator, setAuthenticator] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [device, setDevice] = useState(() => t('setupWizard.deviceDefault'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState<{ auth: AuthState; key: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    // Keep the link out of the address bar (and of history) once it has been read.
    history.replaceState(null, '', location.pathname);
    post<{ secret: string; qrSvg: string }>('/api/setup/authenticator', { token }).then(setAuthenticator, setError);
  }, [token]);

  if (!token) {
    return (
      <div className="auth-card card">
        <h1>{t('setupWizard.title')}</h1>
        <p>{t('setupWizard.noLink')}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-card card">
        <h1>
          <Icon name="check" /> {t('setupWizard.doneTitle')}
        </h1>
        <p>{t('setupWizard.keyBody')}</p>
        <div className="row">
          <input className="mono" readOnly value={done.key} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} aria-label={t('signin.key')} />
          <CopyButton text={done.key} />
        </div>
        <p />
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            onDone(done.auth);
            navigate('/admin/codex', true);
          }}
        >
          {t('setupWizard.next')}
        </button>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMismatch(password !== again);
    if (password !== again) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ auth: AuthState; key: string }>('/api/setup/finish', {
        token,
        password,
        totpSecret: authenticator!.secret,
        code: code.replace(/\s/g, ''),
        keyLabel: device.trim() || undefined,
      });
      setDone(res);
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-card card" onSubmit={submit}>
      <h1>{t('setupWizard.title')}</h1>
      {!authenticator ? (
        error ? <LockedOrError error={error} /> : <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="setup-password">{t('login.password')}</label>
            <input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />
            <span className="hint">{t('setupWizard.passwordHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="setup-password-again">{t('setupWizard.passwordAgain')}</label>
            <input id="setup-password-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
          </div>
          <div className="field">
            <span className="label-text">{t('setupWizard.scan')}</span>
            <img className="qr" src={svgDataUrl(authenticator.qrSvg)} alt={t('setupWizard.scan')} />
            <span className="hint mono">{t('setupWizard.secret', { secret: authenticator.secret.replace(/(.{4})/g, '$1 ').trim() })}</span>
          </div>
          <div className="field">
            <label htmlFor="setup-code">{t('login.code')}</label>
            <input
              id="setup-code"
              className="otp-input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, '').slice(0, 7))}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="setup-device">{t('setupWizard.device')}</label>
            <input id="setup-device" value={device} onChange={(e) => setDevice(e.target.value)} maxLength={60} />
          </div>
          {mismatch ? (
            <div className="alert error" role="alert">
              <Icon name="alert" />
              {t('setupWizard.mismatch')}
            </div>
          ) : (
            <LockedOrError error={error} />
          )}
          <p />
          <button type="submit" className="btn primary" disabled={busy || password.length < 12 || !again || code.replace(/\s/g, '').length !== 6}>
            {t('setupWizard.finish')}
          </button>
        </>
      )}
    </form>
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
