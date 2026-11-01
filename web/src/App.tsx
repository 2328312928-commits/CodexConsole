import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AuthState } from '../../shared/api.js';
import { authEvents, get, post } from './api';
import { SignedInKeyContext } from './auth';
import { CodexStatusProvider } from './codexStatus';
import { ErrorAlert, LangSwitch, Spinner } from './components/ui';
import { Topbar } from './components/Topbar';
import { useI18n } from './i18n';
import { SetupPage, SignInPage } from './pages/AuthPages';
import { ConsolePage } from './pages/console/ConsolePage';
import { navigate, usePath } from './router';

// The admin area is only needed after unlocking it: keep it out of the console bundle.
const AdminPage = lazy(() => import('./pages/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

export function App() {
  const { t } = useI18n();
  const path = usePath();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setAuth(await get<AuthState>('/api/auth/state'));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onLost = () => void refresh();
    authEvents.addEventListener('lost', onLost);
    return () => authEvents.removeEventListener('lost', onLost);
  }, [refresh]);

  const signOut = async () => {
    try {
      setAuth(await post<AuthState>('/api/auth/logout'));
    } catch {
      void refresh();
    }
    navigate('/', true);
  };

  if (!auth) {
    return (
      <div className="app">
        <header className="topbar">
          <span className="brand">{t('app.name')}</span>
          <span className="spacer" />
          <LangSwitch />
        </header>
        <main className="center-page">
          {error ? (
            <div className="auth-card card">
              <ErrorAlert error={error} />
              <p />
              <button type="button" className="btn" onClick={() => void refresh()}>
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <Spinner label={t('common.loading')} />
          )}
        </main>
      </div>
    );
  }

  if (!auth.setupComplete || !auth.loggedIn) {
    return (
      <div className="app">
        <Topbar auth={auth} />
        <main className="center-page">{!auth.setupComplete ? <SetupPage /> : <SignInPage onSignedIn={setAuth} />}</main>
      </div>
    );
  }

  return (
    <CodexStatusProvider>
      <SignedInKeyContext.Provider value={auth.key}>
        <div className="app">
          <Topbar auth={auth} onSignOut={signOut} />
          {path.startsWith('/admin') ? (
            <Suspense fallback={<main className="center-page"><Spinner label={t('common.loading')} /></main>}>
              <AdminPage auth={auth} onAuth={setAuth} />
            </Suspense>
          ) : (
            <ConsolePage />
          )}
        </div>
      </SignedInKeyContext.Provider>
    </CodexStatusProvider>
  );
}
