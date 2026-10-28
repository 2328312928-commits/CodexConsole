import { memo, useMemo, useState } from 'react';
import type { ApprovalDecision, ApprovalInfo, MediaRef, PendingQuestion, SessionInfo, TranscriptEntry, TurnEndData, TurnKind } from '../../../../shared/api.js';
import type { FileUpdateChange, ThreadItem, TurnPlanStep, UserInput } from '../../../../shared/codex.js';
import { fileUrl, post } from '../../api';
import { ErrorAlert, Spinner } from '../../components/ui';
import { fmtBytes, fmtCompact, fmtDuration, fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { renderMarkdown } from '../../markdown';
import { QuestionCard, QuestionLog } from './Questions';
import type { LiveTurn } from './useSessionStream';

export interface TurnActions {
  fork: (turnId: string) => void;
  rewind: (turnId: string) => void;
  /** A turn is running: history can't be changed. */
  busy: boolean;
}

export interface ViewContext {
  session: SessionInfo;
  workspaceRoot: string | null;
  actions?: TurnActions | null;
}

/** Workspace-relative path of an absolute path, if it is inside the workspace. */
export function toWorkspacePath(ctx: ViewContext, abs: string): string | null {
  const root = ctx.workspaceRoot;
  if (!root) return null;
  if (abs === root) return '';
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null;
}

function shortPath(ctx: ViewContext, abs: string): string {
  const cwd = ctx.session.cwd;
  return abs.startsWith(cwd + '/') ? abs.slice(cwd.length + 1) : abs;
}

export function mediaUrl(ref: MediaRef, sessionId: string): string {
  return ref.source === 'store' ? `/api/media/${ref.path.split('/').map(encodeURIComponent).join('/')}` : fileUrl(ref.path, 'view', sessionId);
}

function Markdown({ text, base }: { text: string; base: string | null }) {
  const html = useMemo(() => renderMarkdown(text, base), [text, base]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MediaTile({ media, sessionId, single }: { media: MediaRef; sessionId: string; single?: boolean }) {
  const { t } = useI18n();
  const url = mediaUrl(media, sessionId);
  const download = media.source === 'workspace' ? fileUrl(media.path, 'download', sessionId) : url;
  return (
    <figure className={`media-tile ${single ? 'media-single' : ''}`} style={{ margin: 0 }}>
      {media.kind === 'image' ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={media.name} loading="lazy" />
        </a>
      ) : media.kind === 'video' ? (
        <video src={url} controls preload="metadata" playsInline />
      ) : (
        <audio src={url} controls preload="metadata" />
      )}
      <figcaption className="caption">
        <Icon name={media.kind === 'image' ? 'image' : media.kind === 'video' ? 'video' : 'audio'} size={14} />
        <span title={media.path}>{media.name}</span>
        {media.size !== null ? <small className="muted">{fmtBytes(t, media.size)}</small> : null}
        <a className="btn ghost icon small" href={download} download aria-label={`${t('common.download')} ${media.name}`}>
          <Icon name="download" size={14} />
        </a>
      </figcaption>
    </figure>
  );
}

function MediaGrid({ media, sessionId }: { media: MediaRef[]; sessionId: string }) {
  if (media.length === 0) return null;
  if (media.length === 1) return <MediaTile media={media[0]!} sessionId={sessionId} single />;
  return (
    <div className="media-grid">
      {media.map((m) => (
        <MediaTile key={`${m.source}:${m.path}`} media={m} sessionId={sessionId} />
      ))}
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : undefined}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === 'inProgress') return <span className="spinner" aria-label={t('turn.commandRunning')} />;
  if (status === 'declined') return <span className="badge warn">{t('turn.declined')}</span>;
  if (status === 'failed') return <span className="badge bad">{t('turn.failed')}</span>;
  return null;
}

function Collapsible({ head, children, open }: { head: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="item-card" open={open}>
      <summary>
        <Icon name="chevronRight" size={14} className="chev" />
        {head}
      </summary>
      <div className="item-body">{children}</div>
    </details>
  );
}

export function UserBubble({ content, prompt, ctx }: { content?: UserInput[]; prompt?: string; ctx: ViewContext }) {
  const { t } = useI18n();
  const texts = content?.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text) ?? [];
  const images = content?.filter((c) => c.type === 'localImage').map((c) => (c as { path: string }).path) ?? [];
  // Hide the attachment note the server appends for non-image files.
  const text = (texts.join('\n') || prompt || '').replace(/\n\n\[Attached files in the workspace: [^\]]*\]$/, '');
  return (
    <div className="msg-user">
      {text}
      {images.length > 0 ? (
        <div className="attachments">
          {images.map((p) => {
            const rel = toWorkspacePath(ctx, p);
            return rel !== null ? (
              <a key={p} href={fileUrl(rel, 'view', ctx.session.id)} target="_blank" rel="noopener noreferrer">
                <img src={fileUrl(rel, 'view', ctx.session.id)} alt={t('turn.attachedImage')} loading="lazy" />
              </a>
            ) : (
              <span key={p} className="chip">
                <Icon name="image" size={14} />
                <span>{p.split('/').pop()}</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export const ItemView = memo(function ItemView({
  item,
  media,
  done,
  partial,
  progress,
  ctx,
}: {
  item: ThreadItem & Record<string, any>;
  media: MediaRef[];
  done: boolean;
  partial?: boolean;
  progress?: string | null;
  ctx: ViewContext;
}) {
  const { t } = useI18n();
  const base = ctx.session.workspacePath;
  switch (item.type) {
    case 'userMessage':
      return <UserBubble content={item.content as UserInput[]} ctx={ctx} />;
    case 'agentMessage':
      return (
        <div className="msg-agent">
          <Markdown text={String(item.text ?? '')} base={base} />
          {partial ? <div className="muted">{t('turn.partial')}</div> : null}
        </div>
      );
    case 'reasoning': {
      const summary = (item.summary as string[] | undefined)?.filter(Boolean).join('\n\n') ?? '';
      if (!summary) return done ? null : <Spinner label={t('turn.thinking')} />;
      return (
        <Collapsible head={<><Icon name="brain" size={15} /><span className="label">{t('turn.thinking')}</span>{!done ? <span className="spinner" /> : null}</>}>
          <div className="reasoning">
            <Markdown text={summary} base={base} />
          </div>
        </Collapsible>
      );
    }
    case 'plan':
      return (
        <div className="item-card">
          <div className="item-head">
            <Icon name="check" size={15} />
            <span className="label">{t('turn.plan')}</span>
          </div>
          <div className="item-body">
            <Markdown text={String(item.text ?? '')} base={base} />
          </div>
        </div>
      );
    case 'commandExecution': {
      const output = String(item.aggregatedOutput ?? '');
      return (
        <Collapsible
          head={
            <>
              <Icon name="terminal" size={15} />
              <span className="cmd" title={String(item.command)}>
                {String(item.command)}
              </span>
              <StatusBadge status={String(item.status)} />
              {item.exitCode !== null && item.exitCode !== undefined ? (
                <span className={`badge ${item.exitCode === 0 ? 'good' : 'bad'}`}>{t('turn.exitCode', { code: item.exitCode })}</span>
              ) : null}
              {item.durationMs ? <span className="muted nowrap">{fmtDuration(t, item.durationMs)}</span> : null}
            </>
          }
        >
          {item.cwd && item.cwd !== ctx.session.cwd ? <div className="muted mono">{String(item.cwd)}</div> : null}
          {output ? <pre className="output">{output}</pre> : <span className="muted">{t('turn.noOutput')}</span>}
        </Collapsible>
      );
    }
    case 'fileChange': {
      const changes = (item.changes as FileUpdateChange[] | undefined) ?? [];
      return (
        <Collapsible
          head={
            <>
              <Icon name="edit" size={15} />
              <span className="label">{t('turn.fileChanges')}</span>
              <span className="cmd">{changes.map((c) => shortPath(ctx, c.path)).join(', ')}</span>
              <StatusBadge status={String(item.status)} />
            </>
          }
        >
          {changes.map((c, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <span className="badge info">
                  {c.kind.type === 'add' ? t('turn.fileAdded') : c.kind.type === 'delete' ? t('turn.fileDeleted') : t('turn.fileUpdated')}
                </span>
                <span className="mono">{shortPath(ctx, c.path)}</span>
                {c.kind.type === 'update' && c.kind.move_path ? <span className="muted">{t('turn.fileMoved', { path: shortPath(ctx, c.kind.move_path) })}</span> : null}
              </div>
              {c.diff ? <DiffView diff={c.diff} /> : null}
            </div>
          ))}
        </Collapsible>
      );
    }
    case 'webSearch':
      return (
        <div className="approval-log">
          <Icon name="search" size={14} />
          {t('turn.webSearch', { query: String(item.query ?? '') })}
        </div>
      );
    case 'mcpToolCall':
      return (
        <Collapsible
          head={
            <>
              <Icon name="sparkle" size={15} />
              <span className="cmd">{t('turn.toolCall', { server: String(item.server), tool: String(item.tool) })}</span>
              <StatusBadge status={String(item.status)} />
              {!done && progress ? <span className="muted clip-text">{progress}</span> : null}
              {item.durationMs ? <span className="muted nowrap">{fmtDuration(t, item.durationMs)}</span> : null}
            </>
          }
        >
          <pre className="output">{JSON.stringify(item.arguments, null, 2)}</pre>
          {item.error ? <div className="alert error">{String(item.error.message)}</div> : null}
          {item.result ? <pre className="output">{JSON.stringify(item.result.content, null, 2)}</pre> : null}
        </Collapsible>
      );
    case 'imageView':
    case 'imageGeneration':
      return (
        <div>
          <div className="approval-log" style={{ marginBottom: 6 }}>
            <Icon name="image" size={14} />
            {item.type === 'imageView' ? t('turn.imageViewed') : t('turn.imageGenerated')}
            {item.type === 'imageGeneration' && item.revisedPrompt ? <span className="muted">— {String(item.revisedPrompt)}</span> : null}
          </div>
          {media.length > 0 ? <MediaGrid media={media} sessionId={ctx.session.id} /> : <span className="muted mono">{String(item.path ?? item.savedPath ?? '')}</span>}
        </div>
      );
    case 'contextCompaction':
      return <div className="approval-log">{t('turn.compacted')}</div>;
    default:
      return <div className="approval-log muted">{t('turn.unknownItem', { type: item.type })}</div>;
  }
});

function PlanView({ steps }: { steps: TurnPlanStep[] }) {
  const { t } = useI18n();
  if (steps.length === 0) return null;
  return (
    <div className="item-card">
      <div className="item-head">
        <Icon name="check" size={15} />
        <span className="label">{t('turn.plan')}</span>
      </div>
      <ul className="plan item-body">
        {steps.map((s, i) => (
          <li key={i} className={s.status === 'completed' ? 'done' : undefined}>
            {s.status === 'completed' ? <Icon name="check" size={14} /> : s.status === 'inProgress' ? <span className="spinner" /> : <span className="dot" />}
            {s.step}
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_KEYS = { review: 'turn.kind.review', compact: 'turn.kind.compact', shell: 'turn.kind.shell', auto: 'turn.kind.auto' } as const;

function KindBadge({ kind }: { kind: TurnKind | undefined }) {
  const { t } = useI18n();
  if (!kind || kind === 'prompt') return null;
  return <span className="badge info">{t(KIND_KEYS[kind])}</span>;
}

function TurnFooter({ end, turnId, ctx }: { end: TurnEndData; turnId: string | null; ctx: ViewContext }) {
  const { t, lang } = useI18n();
  const tone = end.status === 'completed' ? '' : end.status === 'interrupted' ? 'warn' : 'bad';
  const actions = ctx.actions;
  return (
    <>
      {end.error && end.status !== 'interrupted' ? (
        <div className="alert error turn-error" role="note">
          <Icon name="alert" />
          <div>
            <strong>{t(`status.${end.status}`)}</strong> — {end.error}
          </div>
        </div>
      ) : null}
      <div className="turn-foot">
        <KindBadge kind={end.kind} />
        {tone ? <span className={`badge ${tone}`}>{t(`status.${end.status}`)}</span> : null}
        {end.durationMs !== null ? <span>{fmtDuration(t, end.durationMs)}</span> : null}
        {end.usage ? <span>{t('turn.tokens', { input: fmtCompact(lang, end.usage.inputTokens), output: fmtCompact(lang, end.usage.outputTokens) })}</span> : null}
        {end.model ? <span>{end.model}</span> : null}
        {actions && turnId && ctx.session.threadId ? (
          <span className="turn-actions">
            <button type="button" className="btn ghost small" disabled={actions.busy} onClick={() => actions.fork(turnId)} title={t('turn.forkHint')}>
              <Icon name="fork" size={14} />
              {t('turn.fork')}
            </button>
            <button type="button" className="btn ghost small" disabled={actions.busy} onClick={() => actions.rewind(turnId)} title={t('turn.rewindHint')}>
              <Icon name="undo" size={14} />
              {t('turn.rewind')}
            </button>
          </span>
        ) : null}
      </div>
    </>
  );
}

const OUTCOME_KEYS = {
  accept: 'approval.outcome.accept',
  acceptForSession: 'approval.outcome.acceptForSession',
  decline: 'approval.outcome.decline',
  timeout: 'approval.outcome.timeout',
  cancelled: 'approval.outcome.cancelled',
} as const;

function ApprovalLog({ data }: { data: { kind: string; command: string | null; outcome: keyof typeof OUTCOME_KEYS; auto?: boolean } }) {
  const { t } = useI18n();
  return (
    <div className="approval-log">
      <Icon name={data.outcome === 'accept' || data.outcome === 'acceptForSession' ? 'check' : 'x'} size={14} />
      <span>{data.auto ? t('approval.outcome.auto') : t(OUTCOME_KEYS[data.outcome] ?? 'approval.outcome.decline')}</span>
      {data.command ? <code className="cmd">{data.command}</code> : null}
    </div>
  );
}

function SteerBubble({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="msg-user steer">
      <span className="badge info">{t('turn.steer')}</span> {text}
    </div>
  );
}

function userText(item: { content?: UserInput[] }): string {
  return (item.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

interface TurnGroup {
  key: string;
  entries: TranscriptEntry[];
}

function groupTurns(entries: TranscriptEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const e of entries) {
    const key = e.turnId ?? e.requestId ?? `e${e.id}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else groups.push({ key, entries: [e] });
  }
  return groups;
}

/** Completed turns from the stored transcript. Memoised: streaming never re-renders it. */
export const History = memo(function History({ entries, ctx }: { entries: TranscriptEntry[]; ctx: ViewContext }) {
  const groups = useMemo(() => groupTurns(entries), [entries]);
  return (
    <>
      {groups.map((g) => {
        const end = g.entries.find((e) => e.kind === 'turnEnd')?.data as (TurnEndData & { prompt?: string }) | undefined;
        const users = g.entries.filter((e) => e.kind === 'userMessage');
        // Codex may echo steering input as a user message; show it once.
        const echoed = new Set(users.slice(1).map((e) => userText(e.data.item)));
        const turnId = g.entries.find((e) => e.turnId)?.turnId ?? null;
        return (
          <section className="turn" key={g.key}>
            {users.length === 0 && end?.prompt ? <UserBubble prompt={end.prompt} ctx={ctx} /> : null}
            {g.entries.map((e) => {
              if (e.kind === 'turnEnd') return null;
              if (e.kind === 'media') return <MediaGrid key={e.id} media={e.data.files as MediaRef[]} sessionId={ctx.session.id} />;
              if (e.kind === 'approval') return <ApprovalLog key={e.id} data={e.data} />;
              if (e.kind === 'question') return <QuestionLog key={e.id} data={e.data} />;
              if (e.kind === 'steer') return echoed.has(String(e.data.text)) ? null : <SteerBubble key={e.id} text={String(e.data.text)} />;
              if (!e.data?.item) return null;
              return <ItemView key={e.id} item={e.data.item} media={e.data.media ?? []} done partial={e.data.partial} ctx={ctx} />;
            })}
            {end ? <TurnFooter end={end} turnId={turnId} ctx={ctx} /> : null}
          </section>
        );
      })}
    </>
  );
});

export function ApprovalCard({ approval, ctx }: { approval: ApprovalInfo; ctx: ViewContext }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/approvals/${approval.id}`, { decision });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <div className="approval" role="group" aria-label={t(`approval.title.${approval.kind}`)}>
      <h3>
        <Icon name="shield" size={16} />
        {t(`approval.title.${approval.kind}`)}
      </h3>
      {approval.command ? <pre>{approval.command}</pre> : null}
      {approval.cwd && approval.cwd !== ctx.session.cwd ? <div className="muted mono">{t('approval.cwd', { cwd: shortPath(ctx, approval.cwd) })}</div> : null}
      {approval.grantRoot ? <div className="mono">{t('approval.grantRoot', { path: approval.grantRoot })}</div> : null}
      {approval.changes?.map((c, i) => (
        <div key={i}>
          <div className="mono">{shortPath(ctx, c.path)}</div>
          {c.diff ? <DiffView diff={c.diff} /> : null}
        </div>
      ))}
      {approval.permissions ? <pre>{JSON.stringify(approval.permissions, null, 2)}</pre> : null}
      {approval.reason ? <div>{t('approval.reason', { reason: approval.reason })}</div> : null}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void decide('accept')}>
          {t('approval.accept')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void decide('acceptForSession')}>
          {t('approval.acceptForSession')}
        </button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void decide('decline')}>
          {t('approval.decline')}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {t('approval.expires', { time: fmtRelative(lang, t, approval.expiresAt) })}
        </span>
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}

export function LiveTurnView({ live, approvals, questions, ctx }: { live: LiveTurn; approvals: ApprovalInfo[]; questions: PendingQuestion[]; ctx: ViewContext }) {
  const { t } = useI18n();
  const user = live.items.find((l) => l.item.type === 'userMessage');
  const rest = live.items.filter((l) => l !== user);
  const echoed = new Set(rest.filter((l) => l.item.type === 'userMessage').map((l) => userText(l.item as { content?: UserInput[] })));
  return (
    <section className="turn" aria-live="polite">
      {user ? (
        <ItemView item={user.item as ThreadItem & Record<string, any>} media={user.media} done ctx={ctx} />
      ) : live.prompt ? (
        <UserBubble prompt={live.prompt} ctx={ctx} />
      ) : null}
      {live.kind !== 'prompt' ? (
        <div>
          <KindBadge kind={live.kind} />
        </div>
      ) : null}
      {live.plan ? <PlanView steps={live.plan.steps} /> : null}
      {rest.map((l) => (
        <ItemView key={l.item.id} item={l.item as ThreadItem & Record<string, any>} media={l.media} done={l.done} progress={l.progress} ctx={ctx} />
      ))}
      {live.steers
        .filter((s) => !echoed.has(s))
        .map((s, i) => (
          <SteerBubble key={i} text={s} />
        ))}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} ctx={ctx} />
      ))}
      {questions.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
      {live.diff ? (
        <Collapsible head={<><Icon name="edit" size={15} /><span className="label">{t('turn.diff')}</span></>}>
          <DiffView diff={live.diff} />
        </Collapsible>
      ) : null}
      <Spinner label={live.statusMessage ?? t('turn.working')} />
    </section>
  );
}

/** Questions that arrived while no turn is shown (e.g. after a reload). */
export function PendingQuestions({ questions }: { questions: PendingQuestion[] }) {
  if (questions.length === 0) return null;
  return (
    <section className="turn">
      {questions.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
    </section>
  );
}
