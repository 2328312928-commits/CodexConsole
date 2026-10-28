import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommandResult, FileEntry, ModelInfo, SessionInfo, SessionSettings, ThreadGoal, TurnKind } from '../../../../shared/api.js';
import { get, patch, post } from '../../api';
import { useCodexStatus } from '../../codexStatus';
import { Menu, type MenuItem } from '../../components/Menu';
import { ConfirmDialog, ErrorAlert, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { Composer, type Attachment, type PromptExtras, type ToolDialog } from './Composer';
import { DeleteSessionDialog, RenameDialog } from './dialogs';
import { FilesPanel } from './FilesPanel';
import { CommandResultDialog, DiffDialog, GoalDialog, ReviewDialog, SettingsDialog, StatusDialog } from './SessionTools';
import { History, LiveTurnView, PendingQuestions, type ViewContext } from './Transcript';
import { useSessionStream } from './useSessionStream';

type Started = { requestId: string; turnId: string | null };

export function SessionView({
  session,
  workspaceRoot,
  models,
  onSessionUpdated,
  onSessionCreated,
  onDeleted,
  onOpenSidebar,
}: {
  session: SessionInfo;
  workspaceRoot: string | null;
  models: ModelInfo[];
  onSessionUpdated: (s: SessionInfo) => void;
  onSessionCreated: (s: SessionInfo) => void;
  onDeleted: () => void;
  onOpenSidebar: () => void;
}) {
  const { t } = useI18n();
  const { status } = useCodexStatus();
  const stream = useSessionStream(session.id, onSessionUpdated);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [filesOpen, setFilesOpen] = useState(() => window.innerWidth > 1100 && session.workspacePath !== null);
  const [dialog, setDialog] = useState<ToolDialog | 'rename' | 'delete' | null>(null);
  const [rewinding, setRewinding] = useState<string | null>(null);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const { optimistic, reload, addSteer } = stream;

  useEffect(() => {
    setAttachments([]);
    setNotice(null);
    setActionError(null);
    atBottom.current = true;
  }, [session.id]);

  const loadGoal = useCallback(() => {
    if (!session.threadId) return;
    get<{ goal: ThreadGoal | null }>(`/api/sessions/${session.id}/goal`)
      .then((r) => setGoal(r.goal))
      .catch(() => setGoal(null));
  }, [session.id, session.threadId]);
  useEffect(loadGoal, [loadGoal]);
  useEffect(() => {
    if (stream.goal !== undefined) setGoal(stream.goal);
  }, [stream.goal]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [stream.entries, stream.live, stream.approvals, stream.questions]);

  const running = stream.live !== null || session.running;
  const disabledReason = !status
    ? null
    : status.state !== 'ready'
      ? t('error.codex_unavailable')
      : !status.signedIn
        ? t('composer.disabledNotSignedIn')
        : null;

  const act = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    }
  }, []);

  const started = useCallback(
    (r: Started, label: string, kind: TurnKind) => {
      atBottom.current = true;
      optimistic(r.requestId, r.turnId, label, kind);
    },
    [optimistic],
  );

  const fork = useCallback(
    (turnId: string | null) =>
      void act(async () => {
        const res = await post<{ session: SessionInfo }>(`/api/sessions/${session.id}/fork`, { turnId });
        onSessionCreated(res.session);
      }),
    [act, session.id, onSessionCreated],
  );

  const ctx: ViewContext = useMemo(
    () => ({ session, workspaceRoot, actions: { fork: (turnId: string) => fork(turnId), rewind: setRewinding, busy: running } }),
    [session, workspaceRoot, fork, running],
  );

  const send = async (text: string, extras: PromptExtras) => {
    const res = await post<Started>(`/api/sessions/${session.id}/turns`, { text, attachments: attachments.map((a) => a.path), ...extras });
    started(res, text, 'prompt');
    setAttachments([]);
  };

  const steer = async (text: string) => {
    await post(`/api/sessions/${session.id}/steer`, { text });
    atBottom.current = true;
    addSteer(text);
  };

  const command = async (text: string) => {
    setNotice(null);
    const res = await post<CommandResult>(`/api/sessions/${session.id}/command`, { command: text });
    switch (res.kind) {
      case 'session':
        onSessionCreated(res.session);
        break;
      case 'turn':
        started(res, text, text.startsWith('!') ? 'shell' : text.startsWith('/review') ? 'review' : text.startsWith('/compact') ? 'compact' : 'prompt');
        break;
      case 'settings':
        onSessionUpdated(res.session);
        setNotice(t('settings.updated'));
        break;
      case 'done':
        setNotice(t('commands.done'));
        void reload();
        break;
      default:
        setCommandResult(res);
    }
  };

  const updateSettings = async (p: Partial<SessionSettings>) => {
    const res = await patch<{ session: SessionInfo }>(`/api/sessions/${session.id}/settings`, p);
    onSessionUpdated(res.session);
  };

  const attach = (e: FileEntry) => {
    setAttachments((prev) => (prev.some((a) => a.path === e.path) ? prev : [...prev, { path: e.path, name: e.name, size: e.size ?? 0 }]));
  };

  const hasThread = session.threadId !== null;
  const menu: MenuItem[] = [
    { label: t('session.settings'), icon: 'sliders', onSelect: () => setDialog('settings') },
    { label: t('session.review'), icon: 'eye', onSelect: () => setDialog('review'), disabled: running || !hasThread },
    {
      label: t('session.compact'),
      icon: 'compress',
      disabled: running || !hasThread,
      onSelect: () => void act(async () => started(await post<Started>(`/api/sessions/${session.id}/compact`), '/compact', 'compact')),
    },
    { label: t('session.diff'), icon: 'edit', onSelect: () => setDialog('diff') },
    { label: t('session.status'), icon: 'info', onSelect: () => setDialog('status') },
    { label: t('session.goal'), icon: 'target', onSelect: () => setDialog('goal'), disabled: !hasThread },
    { label: t('session.fork'), icon: 'fork', onSelect: () => fork(null), disabled: running || !hasThread },
    { label: t('session.rewindLast'), icon: 'undo', onSelect: () => setRewinding(''), disabled: running || !hasThread },
    ...(hasThread
      ? [
          {
            label: t('session.sync'),
            icon: 'sync' as const,
            disabled: running,
            onSelect: () =>
              void act(async () => {
                const res = await post<{ imported: number }>(`/api/sessions/${session.id}/sync`);
                setNotice(t('session.synced', { count: res.imported }));
                void reload();
              }),
          },
        ]
      : []),
    { label: t('session.rename'), icon: 'edit', onSelect: () => setDialog('rename') },
    {
      label: session.archivedAt === null ? t('session.archive') : t('session.unarchive'),
      icon: 'archive',
      onSelect: () =>
        void act(async () => {
          const res = await patch<{ session: SessionInfo }>(`/api/sessions/${session.id}`, { archived: session.archivedAt === null });
          onSessionUpdated(res.session);
        }),
    },
    { label: t('session.delete'), icon: 'trash', danger: true, disabled: running, onSelect: () => setDialog('delete') },
  ];

  const isEmpty = stream.loaded && stream.entries.length === 0 && !stream.live;
  const s = session.settings;
  const overrides = [s.sandbox ? t(`sandbox.${s.sandbox}`) : null, s.approvalPolicy ? t(`approvalPolicy.${s.approvalPolicy}`) : null].filter(Boolean).join(' · ');

  return (
    <>
      <div className="main">
        <div className="session-head">
          <button type="button" className="btn ghost icon small only-mobile" onClick={onOpenSidebar} aria-label={t('sessions.title')}>
            <Icon name="menu" />
          </button>
          <div className="titles">
            <h2 title={session.title}>{session.title || t('sessions.untitled')}</h2>
            <div className="folder mono" title={session.cwd}>
              {session.workspacePath !== null ? session.workspacePath || '/' : `${session.cwd} (${t('session.outsideWorkspace')})`}
              {session.apiKey ? (
                <span className="badge" title={t('session.viaKeyHint')}>
                  <Icon name="key" size={12} /> {session.apiKey.label}
                </span>
              ) : null}
            </div>
          </div>
          {goal ? (
            <button type="button" className="btn ghost small goal-pill hide-mobile" onClick={() => setDialog('goal')} title={goal.objective}>
              <Icon name="target" size={15} />
              <span>{goal.objective}</span>
            </button>
          ) : null}
          <button type="button" className="btn ghost small" onClick={() => setDialog('settings')} title={t('session.settings')} aria-label={t('session.settings')}>
            <Icon name="sliders" size={16} />
            {overrides ? <span className="hide-mobile settings-summary">{overrides}</span> : null}
          </button>
          <Menu label={t('session.actions')} items={menu} />
          <button
            type="button"
            className="btn small"
            onClick={() => setFilesOpen((v) => !v)}
            aria-pressed={filesOpen}
            disabled={session.workspacePath === null}
            title={session.workspacePath === null ? t('files.unavailable') : t('session.files')}
          >
            <Icon name="panel" size={16} />
            <span className="hide-mobile">{t('session.files')}</span>
          </button>
        </div>

        {status && (status.state !== 'ready' || !status.signedIn || status.versionMismatch) || actionError || notice ? (
          <div className="banners">
            {status && status.state !== 'ready' ? (
              <div className="alert warn">
                <Icon name="alert" />
                {t('codex.unavailable', { state: t(`codex.state.${status.state}`) })}
              </div>
            ) : status && !status.signedIn ? (
              <div className="alert warn">
                <Icon name="key" />
                {t('codex.notSignedIn')}
              </div>
            ) : null}
            {status?.versionMismatch ? (
              <div className="alert">
                <Icon name="info" />
                {t('codex.versionMismatch', { version: status.version ?? '?', tested: status.testedVersion })}
              </div>
            ) : null}
            {notice ? (
              <div className="alert" role="status">
                <Icon name="check" />
                {notice}
              </div>
            ) : null}
            <ErrorAlert error={actionError} />
          </div>
        ) : null}

        <div
          className="transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          <div className="transcript-inner">
            {stream.hasMore ? (
              <button type="button" className="btn small" style={{ alignSelf: 'center' }} onClick={() => void stream.loadOlder()}>
                {t('session.loadOlder')}
              </button>
            ) : null}
            {!stream.loaded ? <Spinner label={t('common.loading')} /> : null}
            <ErrorAlert error={stream.error} />
            <History entries={stream.entries} ctx={ctx} />
            {stream.live ? (
              <LiveTurnView live={stream.live} approvals={stream.approvals} questions={stream.questions} ctx={ctx} />
            ) : (
              <PendingQuestions questions={stream.questions} />
            )}
            {isEmpty ? <p className="empty">{t('session.emptyTranscript')}</p> : null}
            {!stream.connected && stream.loaded ? <div className="muted" style={{ fontSize: 12 }}>{t('turn.reconnecting')}</div> : null}
          </div>
        </div>

        <Composer
          session={session}
          models={models}
          running={running}
          disabledReason={disabledReason}
          attachments={attachments}
          setAttachments={setAttachments}
          onSend={send}
          onCommand={command}
          onSteer={steer}
          onStop={async () => {
            await post(`/api/sessions/${session.id}/interrupt`);
          }}
          onSettings={updateSettings}
          onTool={setDialog}
        />
      </div>
      {filesOpen && session.workspacePath !== null ? (
        <FilesPanel startPath={session.workspacePath} sessionId={session.id} onAttach={attach} onClose={() => setFilesOpen(false)} />
      ) : null}
      {dialog === 'rename' ? (
        <RenameDialog
          session={session}
          onClose={() => setDialog(null)}
          onDone={(next) => {
            setDialog(null);
            onSessionUpdated(next);
          }}
        />
      ) : null}
      {dialog === 'delete' ? <DeleteSessionDialog session={session} onClose={() => setDialog(null)} onDeleted={onDeleted} /> : null}
      {dialog === 'settings' ? <SettingsDialog session={session} models={models} onClose={() => setDialog(null)} onSaved={onSessionUpdated} /> : null}
      {dialog === 'review' ? <ReviewDialog sessionId={session.id} onClose={() => setDialog(null)} onStarted={(r, label) => started(r, label, 'review')} /> : null}
      {dialog === 'diff' ? <DiffDialog sessionId={session.id} onClose={() => setDialog(null)} /> : null}
      {dialog === 'status' ? <StatusDialog sessionId={session.id} onClose={() => setDialog(null)} /> : null}
      {dialog === 'goal' ? (
        <GoalDialog
          sessionId={session.id}
          onClose={() => {
            setDialog(null);
            loadGoal();
          }}
        />
      ) : null}
      {commandResult ? <CommandResultDialog result={commandResult} onClose={() => setCommandResult(null)} /> : null}
      {rewinding !== null ? (
        <ConfirmDialog
          title={t('rewind.title')}
          message={rewinding ? t('rewind.body') : t('rewind.bodyLast')}
          confirmLabel={t('turn.rewind')}
          danger
          onClose={() => setRewinding(null)}
          onConfirm={async () => {
            await post(`/api/sessions/${session.id}/undo`, { turnId: rewinding || null });
            setNotice(t('rewind.done'));
            void reload();
          }}
        />
      ) : null}
    </>
  );
}
