import { useCallback, useEffect, useState } from 'react';
import type { ApprovalInfo, ModelInfo, PendingQuestion, SessionInfo } from '../../../../shared/api.js';
import { get, qs } from '../../api';
import { ErrorAlert, Spinner } from '../../components/ui';
import { fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { navigate, usePath } from '../../router';
import { ImportDialog, NewSessionDialog } from './dialogs';
import { SessionView } from './SessionView';

export function ConsolePage() {
  const { t, lang } = useI18n();
  const path = usePath();
  const selectedId = /^\/s\/([^/]+)/.exec(path)?.[1] ?? null;
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [waiting, setWaiting] = useState<Array<{ sessionId: string; count: number }>>([]);

  const load = useCallback(async () => {
    try {
      const res = await get<{ sessions: SessionInfo[]; workspaceRoot: string }>(`/api/sessions${qs({ archived: archived ? 1 : undefined, q: query.trim() || undefined })}`);
      setSessions(res.sessions);
      setWorkspaceRoot(res.workspaceRoot);
      setError(null);
    } catch (err) {
      setError(err);
      setSessions((prev) => prev ?? []);
    }
  }, [archived, query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // Approvals and questions waiting in any session (so nothing stalls unseen in another one).
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      get<{ approvals: ApprovalInfo[]; questions: PendingQuestion[] }>('/api/approvals')
        .then((r) => {
          const counts = new Map<string, number>();
          for (const x of [...r.approvals, ...r.questions]) counts.set(x.sessionId, (counts.get(x.sessionId) ?? 0) + 1);
          setWaiting([...counts].map(([sessionId, count]) => ({ sessionId, count })));
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, 10_000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  useEffect(() => {
    get<{ models: ModelInfo[] }>('/api/codex/models')
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);

  // Keep the open session even when it is not in the current (filtered) list.
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const inList = sessions?.find((s) => s.id === selectedId);
    if (inList) {
      setSelected(inList);
      return;
    }
    if (selected?.id === selectedId) return;
    get<{ session: SessionInfo }>(`/api/sessions/${selectedId}`)
      .then((r) => setSelected(r.session))
      .catch(() => navigate('/', true));
  }, [selectedId, sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSessionUpdated = useCallback((s: SessionInfo) => {
    setSessions((prev) => (prev ? prev.map((x) => (x.id === s.id ? s : x)) : prev));
    setSelected((prev) => (prev && prev.id === s.id ? s : prev));
  }, []);

  const open = (id: string) => {
    navigate(`/s/${id}`);
    setSidebarOpen(false);
  };

  const onSessionCreated = useCallback((s: SessionInfo) => {
    setArchived(false);
    setSessions((prev) => [s, ...(prev ?? []).filter((x) => x.id !== s.id)]);
    setSelected(s);
    navigate(`/s/${s.id}`);
  }, []);

  const waitingElsewhere = waiting.filter((w) => w.sessionId !== selectedId);
  const titleOf = (id: string) => sessions?.find((s) => s.id === id)?.title || t('sessions.untitled');

  return (
    <div className="console">
      {sidebarOpen ? <div className="scrim only-mobile" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label={t('sessions.title')}>
        <div className="sidebar-head">
          <button type="button" className="btn primary" onClick={() => setDialog('new')}>
            <Icon name="plus" size={16} />
            {t('sessions.new')}
          </button>
          <div className="search">
            <Icon name="search" size={16} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('sessions.search')} aria-label={t('sessions.search')} />
          </div>
          <div className="seg" role="group">
            <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>
              {t('sessions.active')}
            </button>
            <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>
              {t('sessions.archived')}
            </button>
          </div>
        </div>
        {waitingElsewhere.length > 0 ? (
          <div className="alert warn waiting" role="status">
            <Icon name="shield" />
            <div>
              <div>{t('sessions.waiting')}</div>
              {waitingElsewhere.map((w) => (
                <button key={w.sessionId} type="button" className="link-btn" onClick={() => open(w.sessionId)}>
                  {t('sessions.waitingItem', { title: titleOf(w.sessionId), count: w.count })}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {error ? <div style={{ padding: 10 }}><ErrorAlert error={error} /></div> : null}
        {sessions === null ? (
          <div style={{ padding: 16 }}>
            <Spinner />
          </div>
        ) : sessions.length === 0 ? (
          <p className="empty">{query ? t('sessions.emptySearch') : t('sessions.empty')}</p>
        ) : (
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className="session-item" aria-current={s.id === selectedId ? 'true' : undefined} onClick={() => open(s.id)}>
                  <div className="title">
                    {s.running ? <span className="spinner" aria-label={t('sessions.running')} /> : null}
                    <span>{s.title || t('sessions.untitled')}</span>
                    {waiting.some((w) => w.sessionId === s.id) ? <Icon name="shield" size={14} className="waiting-icon" role="img" aria-hidden={false} aria-label={t('sessions.needsYou')} /> : null}
                  </div>
                  {s.apiKey || s.forkedFrom ? (
                    <div className="meta tags">
                      {s.apiKey ? (
                        <span className="badge" title={t('session.viaKeyHint')}>
                          <Icon name="key" size={12} /> {s.apiKey.label}
                        </span>
                      ) : null}
                      {s.forkedFrom ? (
                        <span className="badge">
                          <Icon name="fork" size={12} /> {t('sessions.forked')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="meta">
                    {t('sessions.updated', { time: fmtRelative(lang, t, s.updatedAt) })}
                    {s.workspacePath ? ` · ${s.workspacePath}` : ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sidebar-foot">
          <button type="button" className="btn small ghost" onClick={() => setDialog('import')}>
            <Icon name="history" size={15} />
            {t('sessions.import')}
          </button>
        </div>
      </aside>

      {selected ? (
        <SessionView
          key={selected.id}
          session={selected}
          workspaceRoot={workspaceRoot}
          models={models}
          onSessionUpdated={onSessionUpdated}
          onSessionCreated={onSessionCreated}
          onDeleted={() => {
            navigate('/', true);
            void load();
          }}
          onOpenSidebar={() => setSidebarOpen(true)}
          onImport={() => setDialog('import')}
        />
      ) : (
        <div className="main">
          <div className="session-head only-mobile">
            <button type="button" className="btn ghost icon small" onClick={() => setSidebarOpen(true)} aria-label={t('sessions.title')}>
              <Icon name="menu" />
            </button>
            <h2>{t('sessions.title')}</h2>
          </div>
          <div className="center-page" style={{ flex: 1 }}>
            <div className="empty">
              <p>{t('session.pick')}</p>
              <button type="button" className="btn primary" onClick={() => setDialog('new')}>
                <Icon name="plus" size={16} />
                {t('sessions.new')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'new' ? (
        <NewSessionDialog
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            setArchived(false);
            setSessions((prev) => [s, ...(prev ?? [])]);
            open(s.id);
          }}
        />
      ) : null}
      {dialog === 'import' ? (
        <ImportDialog
          onClose={() => setDialog(null)}
          onImported={(s) => {
            setDialog(null);
            void load();
            open(s.id);
          }}
        />
      ) : null}
    </div>
  );
}
