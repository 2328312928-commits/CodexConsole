import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import type { FileEntry } from '../../../../shared/api.js';
import { fileUrl, get, post, qs, uploadFiles } from '../../api';
import { ConfirmDialog, ErrorAlert, Modal, Spinner } from '../../components/ui';
import { fmtBytes, fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../../icons';

const TEXT_PREVIEW_MAX = 1024 * 1024;

function iconFor(e: FileEntry): IconName {
  if (e.type === 'dir') return 'folder';
  if (e.media === 'image') return 'image';
  if (e.media === 'video') return 'video';
  if (e.media === 'audio') return 'audio';
  return 'file';
}

export function PreviewDialog({ entry, sessionId, onClose, onAttach }: { entry: FileEntry; sessionId?: string; onClose: () => void; onAttach?: (e: FileEntry) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const url = fileUrl(entry.path, 'view', sessionId);
  const isText = !entry.media && entry.mime !== null && (entry.mime.startsWith('text/') || entry.mime === 'application/json');
  useEffect(() => {
    if (!isText || (entry.size ?? 0) > TEXT_PREVIEW_MAX) return;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setText)
      .catch(setError);
  }, [url, isText, entry.size]);
  return (
    <Modal
      title={entry.name}
      onClose={onClose}
      wide
      footer={
        <>
          {onAttach ? (
            <button type="button" className="btn" onClick={() => { onAttach(entry); onClose(); }}>
              <Icon name="clip" size={15} />
              {t('files.attach')}
            </button>
          ) : null}
          <a className="btn primary" href={fileUrl(entry.path, 'download', sessionId)} download>
            <Icon name="download" size={15} />
            {t('common.download')}
          </a>
        </>
      }
    >
      {entry.media === 'image' ? (
        <img className="preview-media" src={url} alt={entry.name} />
      ) : entry.media === 'video' ? (
        <video className="preview-media" src={url} controls autoPlay playsInline />
      ) : entry.media === 'audio' ? (
        <audio src={url} controls autoPlay style={{ width: '100%' }} />
      ) : isText && (entry.size ?? 0) <= TEXT_PREVIEW_MAX ? (
        error ? <ErrorAlert error={error} /> : text === null ? <Spinner /> : <pre className="preview-text">{text}</pre>
      ) : (
        <p className="muted">{t('files.noPreview')}</p>
      )}
      <p className="muted mono" style={{ fontSize: 12 }}>
        {entry.path} · {fmtBytes(t, entry.size)}
      </p>
    </Modal>
  );
}

export function FilesPanel({ startPath, sessionId, onAttach, onClose }: { startPath: string; sessionId?: string; onAttach?: (e: FileEntry) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [dir, setDir] = useState(startPath);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setDir(startPath), [startPath]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await get<{ path: string; entries: FileEntry[]; truncated: boolean }>(`/api/files${qs({ path: dir })}`);
      setEntries(res.entries);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err);
      setEntries([]);
    }
  }, [dir]);

  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setProgress(0);
    try {
      const res = await uploadFiles(dir, files, { session: sessionId, onProgress: setProgress });
      setNotice(t('files.uploaded', { count: res.files.length }));
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
      void load();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  const segments = dir ? dir.split('/') : [];

  return (
    <aside
      className={`files-panel ${dragging ? 'dragging' : ''}`}
      aria-label={t('files.title')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="panel-head">
        <Icon name="folder" />
        <h2>{t('files.title')}</h2>
        <label className="btn small" title={t('files.upload')}>
          <Icon name="upload" size={15} />
          <span className="hide-mobile">{t('files.upload')}</span>
          <input type="file" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
        <button type="button" className="btn ghost icon small" onClick={() => setMkdirOpen(true)} aria-label={t('files.newFolder')} title={t('files.newFolder')}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" className="btn ghost icon small" onClick={() => void load()} aria-label={t('common.refresh')} title={t('common.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
        <button type="button" className="btn ghost icon small" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <nav className="crumbs" aria-label={t('files.title')}>
        <button type="button" onClick={() => setDir('')}>
          {t('files.root')}
        </button>
        {segments.map((s, i) => (
          <span key={i}>
            /
            <button type="button" onClick={() => setDir(segments.slice(0, i + 1).join('/'))}>
              {s}
            </button>
          </span>
        ))}
      </nav>
      {progress !== null ? (
        <div className="progress" style={{ margin: '6px 10px' }}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {notice ? <div className="alert" style={{ margin: '6px 10px' }} role="status"><Icon name="check" />{notice}</div> : null}
      {error ? <div style={{ margin: '6px 10px' }}><ErrorAlert error={error} /></div> : null}
      {entries === null ? (
        <div style={{ padding: 16 }}>
          <Spinner />
        </div>
      ) : entries.length === 0 && !error ? (
        <p className="empty">{dragging ? t('files.dropHere') : t('files.empty')}</p>
      ) : (
        <ul className="file-list">
          {entries.map((e) => (
            <li key={e.path} className="file-row">
              <Icon name={iconFor(e)} />
              <button
                type="button"
                className="name"
                onClick={() => (e.type === 'dir' ? setDir(e.path) : e.type === 'file' ? setPreview(e) : undefined)}
                title={e.type === 'link' ? t('files.link') : e.name}
              >
                <span>{e.name}</span>
                <small>
                  {e.type === 'file' ? `${fmtBytes(t, e.size)} · ` : ''}
                  {fmtRelative(lang, t, e.mtime)}
                </small>
              </button>
              <span className="actions">
                {e.type === 'file' && onAttach ? (
                  <button type="button" className="btn ghost icon small" onClick={() => onAttach(e)} aria-label={`${t('files.attach')}: ${e.name}`} title={t('files.attach')}>
                    <Icon name="clip" size={15} />
                  </button>
                ) : null}
                {e.type === 'file' ? (
                  <a className="btn ghost icon small" href={fileUrl(e.path, 'download', sessionId)} download aria-label={`${t('common.download')}: ${e.name}`} title={t('common.download')}>
                    <Icon name="download" size={15} />
                  </a>
                ) : null}
                {e.type !== 'link' ? (
                  <button type="button" className="btn ghost icon small danger" onClick={() => setDeleting(e)} aria-label={`${t('common.delete')}: ${e.name}`} title={t('common.delete')}>
                    <Icon name="trash" size={15} />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {truncated ? <p className="muted" style={{ padding: '0 10px', fontSize: 12 }}>{t('files.truncated', { count: entries?.length ?? 0 })}</p> : null}
      {preview ? <PreviewDialog entry={preview} sessionId={sessionId} onClose={() => setPreview(null)} onAttach={onAttach} /> : null}
      {deleting ? (
        <ConfirmDialog
          title={t('common.delete')}
          message={deleting.type === 'dir' ? t('files.deleteFolderConfirm', { name: deleting.name }) : t('files.deleteConfirm', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await post('/api/files/delete', { path: deleting.path });
            void load();
          }}
        />
      ) : null}
      {mkdirOpen ? <MkdirDialog dir={dir} onClose={() => setMkdirOpen(false)} onDone={(p) => { setMkdirOpen(false); setDir(p); }} /> : null}
    </aside>
  );
}

function MkdirDialog({ dir, onClose, onDone }: { dir: string; onClose: () => void; onDone: (path: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await post<{ path: string }>('/api/files/mkdir', { path: dir ? `${dir}/${name.trim()}` : name.trim() });
      onDone(res.path);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t('files.newFolder')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="mkdir-name">{t('files.newFolderName')}</label>
          <input id="mkdir-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={200} />
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            {t('newSession.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
