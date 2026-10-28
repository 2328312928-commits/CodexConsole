import { useEffect, useState, type FormEvent } from 'react';
import type { CodexThreadSummary, SessionInfo } from '../../../../shared/api.js';
import { del, get, patch, post, qs } from '../../api';
import { ConfirmDialog, ErrorAlert, Modal, Spinner } from '../../components/ui';
import { fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';

export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: SessionInfo) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ session: SessionInfo }>('/api/sessions', { title: title.trim() || undefined, folder: folder.trim() || undefined });
      onCreated(res.session);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('newSession.title')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="ns-title">{t('newSession.name')}</label>
          <input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="ns-folder">{t('newSession.folder')}</label>
          <input id="ns-folder" className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={500} placeholder="my-project" spellCheck={false} />
          <span className="hint">{t('newSession.folderHint')}</span>
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('newSession.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (s: SessionInfo) => void }) {
  const { t, lang } = useI18n();
  const [threads, setThreads] = useState<CodexThreadSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (from: string | null) => {
    try {
      const res = await get<{ threads: CodexThreadSummary[]; nextCursor: string | null }>(`/api/codex/threads${qs({ cursor: from })}`);
      setThreads((prev) => (from ? [...(prev ?? []), ...res.threads] : res.threads));
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err);
      setThreads((prev) => prev ?? []);
    }
  };
  useEffect(() => {
    void load(null);
  }, []);

  return (
    <Modal title={t('import.title')} onClose={onClose} wide>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('import.body')}
      </p>
      <ErrorAlert error={error} />
      {threads === null ? (
        <Spinner label={t('common.loading')} />
      ) : threads.length === 0 ? (
        <p className="empty">{t('import.empty')}</p>
      ) : (
        <ul className="thread-list">
          {threads.map((th) => (
            <li key={th.id}>
              <div className="info">
                <div>
                  <strong>{th.name || th.preview || th.id}</strong>
                </div>
                <div className="muted mono" style={{ fontSize: 12 }} title={th.cwd}>
                  {th.cwd}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('sessions.updated', { time: fmtRelative(lang, t, th.updatedAt) })}
                  {!th.insideWorkspace ? ` · ${t('import.outside')}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busyId !== null}
                onClick={async () => {
                  setBusyId(th.id);
                  setError(null);
                  try {
                    const res = await post<{ session: SessionInfo }>('/api/sessions/import', { threadId: th.id });
                    onImported(res.session);
                  } catch (err) {
                    setError(err);
                    setBusyId(null);
                  }
                }}
              >
                <Icon name="history" size={15} />
                {t('import.button')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <p>
          <button type="button" className="btn small" onClick={() => void load(cursor)}>
            {t('import.loadMore')}
          </button>
        </p>
      ) : null}
    </Modal>
  );
}

export function RenameDialog({ session, onClose, onDone }: { session: SessionInfo; onClose: () => void; onDone: (s: SessionInfo) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await patch<{ session: SessionInfo }>(`/api/sessions/${session.id}`, { title });
      onDone(res.session);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t('session.rename')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="rn-title">{t('newSession.name')}</label>
          <input id="rn-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteSessionDialog({ session, onClose, onDeleted }: { session: SessionInfo; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [thread, setThread] = useState<'keep' | 'archive' | 'delete'>('keep');
  return (
    <ConfirmDialog
      title={t('session.delete')}
      message={t('session.deleteConfirm', { title: session.title || t('sessions.untitled') })}
      confirmLabel={t('common.delete')}
      danger
      onClose={onClose}
      onConfirm={async () => {
        await del(`/api/sessions/${session.id}${qs({ archiveThread: thread === 'archive' ? 1 : undefined, deleteThread: thread === 'delete' ? 1 : undefined })}`);
        onDeleted();
      }}
    >
      {session.threadId ? (
        <div className="seg-ctl" role="radiogroup" aria-label={t('session.codexThread')}>
          {(['keep', 'archive', 'delete'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={thread === v} onClick={() => setThread(v)}>
              {t(`session.thread.${v}`)}
            </button>
          ))}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
