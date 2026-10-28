import { useEffect, useState, type FormEvent } from 'react';
import type { CommandResult, EffectiveSettings, ModelInfo, ReviewTarget, SessionInfo, SessionSettings, SessionStatus, SkillInfo, ThreadGoal } from '../../../../shared/api.js';
import { del, get, patch, post, qs } from '../../api';
import { ErrorAlert, Modal, Spinner } from '../../components/ui';
import { fmtCompact, fmtDuration } from '../../format';
import type { MessageKey } from '../../../../shared/i18n/index.js';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { LimitMeter } from '../admin/charts';
import { DiffView } from './Transcript';

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const APPROVALS = ['untrusted', 'on-request', 'never'] as const;

/** Model, reasoning, sandbox, approvals and network for one session ("Default" = console default). */
export function SettingsDialog({ session, models, onClose, onSaved }: { session: SessionInfo; models: ModelInfo[]; onClose: () => void; onSaved: (s: SessionInfo) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<SessionSettings>(session.settings);
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<{ effective: EffectiveSettings }>(`/api/sessions/${session.id}`)
      .then((r) => setEffective(r.effective))
      .catch(setError);
  }, [session.id]);
  const model = models.find((m) => m.id === form.model) ?? models.find((m) => m.isDefault);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await patch<{ session: SessionInfo }>(`/api/sessions/${session.id}/settings`, form);
      onSaved(res.session);
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  const opt = (v: string | null) => v ?? '';
  return (
    <Modal title={t('settings.sessionTitle')} onClose={onClose}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="st-model">{t('session.model')}</label>
          <select id="st-model" value={opt(form.model)} onChange={(e) => setForm({ ...form, model: e.target.value || null, effort: null })}>
            <option value="">{t('session.defaultModel')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-effort">{t('session.effort')}</label>
          <select id="st-effort" value={opt(form.effort)} onChange={(e) => setForm({ ...form, effort: e.target.value || null })}>
            <option value="">{t('session.defaultModel')}</option>
            {(model?.efforts ?? []).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-sandbox">{t('settings.sandbox')}</label>
          <select id="st-sandbox" value={opt(form.sandbox)} onChange={(e) => setForm({ ...form, sandbox: (e.target.value || null) as SessionSettings['sandbox'] })}>
            <option value="">{t('settings.useDefault')}</option>
            {SANDBOXES.map((x) => (
              <option key={x} value={x}>
                {t(`sandbox.${x}`)}
              </option>
            ))}
          </select>
          {form.sandbox === 'danger-full-access' ? (
            <span className="hint danger-text">
              <Icon name="alert" size={13} /> {t('settings.fullAccessWarning')}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="st-approvals">{t('settings.approvalPolicy')}</label>
          <select id="st-approvals" value={opt(form.approvalPolicy)} onChange={(e) => setForm({ ...form, approvalPolicy: (e.target.value || null) as SessionSettings['approvalPolicy'] })}>
            <option value="">{t('settings.useDefault')}</option>
            {APPROVALS.map((x) => (
              <option key={x} value={x}>
                {t(`approvalPolicy.${x}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-network">{t('settings.network')}</label>
          <select
            id="st-network"
            value={form.networkAccess === null ? '' : form.networkAccess ? 'on' : 'off'}
            onChange={(e) => setForm({ ...form, networkAccess: e.target.value === '' ? null : e.target.value === 'on' })}
          >
            <option value="">{t('settings.useDefault')}</option>
            <option value="on">{t('codex.networkOn')}</option>
            <option value="off">{t('codex.networkOff')}</option>
          </select>
        </div>
        {effective ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {t('settings.effectiveNow', {
              sandbox: t(`sandbox.${effective.sandbox}`),
              approvals: t(`approvalPolicy.${effective.approvalPolicy}`),
              network: effective.networkAccess ? t('codex.networkOn') : t('codex.networkOff'),
            })}
          </p>
        ) : null}
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

const REVIEW_VALUE_KEYS = { baseBranch: 'review.baseBranchValue', commit: 'review.commitValue', custom: 'review.customValue' } as const;

const GOAL_STATUS_KEYS: Record<string, MessageKey> = {
  active: 'goal.status.active',
  paused: 'goal.status.paused',
  blocked: 'goal.status.blocked',
  usageLimited: 'goal.status.usageLimited',
  budgetLimited: 'goal.status.budgetLimited',
  complete: 'goal.status.complete',
};

export function GoalStatus({ status }: { status: string }) {
  const { t } = useI18n();
  const key = GOAL_STATUS_KEYS[status];
  return <span className={`badge ${status === 'complete' ? 'good' : status === 'active' ? 'info' : 'warn'}`}>{key ? t(key) : status}</span>;
}

export function ReviewDialog({ sessionId, onClose, onStarted }: { sessionId: string; onClose: () => void; onStarted: (r: { requestId: string; turnId: string | null }, label: string) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ReviewTarget['type']>('uncommittedChanges');
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const target: ReviewTarget =
      kind === 'uncommittedChanges'
        ? { type: kind }
        : kind === 'baseBranch'
          ? { type: kind, branch: value.trim() }
          : kind === 'commit'
            ? { type: kind, sha: value.trim() }
            : { type: kind, instructions: value.trim() };
    try {
      onStarted(await post(`/api/sessions/${sessionId}/review`, { target }), `/review`);
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  const needsValue = kind !== 'uncommittedChanges';
  return (
    <Modal title={t('review.title')} onClose={onClose}>
      <form onSubmit={submit}>
        {(['uncommittedChanges', 'baseBranch', 'commit', 'custom'] as const).map((k) => (
          <label key={k} className="checkbox" style={{ marginBottom: 8 }}>
            <input type="radio" name="review-kind" checked={kind === k} onChange={() => setKind(k)} />
            {t(`review.${k}`)}
          </label>
        ))}
        {needsValue ? (
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="review-value">{t(REVIEW_VALUE_KEYS[kind as keyof typeof REVIEW_VALUE_KEYS])}</label>
            {kind === 'custom' ? (
              <textarea id="review-value" rows={4} value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
            ) : (
              <input id="review-value" className="mono" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
            )}
          </div>
        ) : null}
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={needsValue && !value.trim()}>
            {t('review.start')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DiffBlock({ turnDiff, gitDiff, gitError }: { turnDiff: string | null; gitDiff: string | null; gitError: string | null }) {
  const { t } = useI18n();
  return (
    <>
      <h3 className="section-title">{t('diff.turn')}</h3>
      {turnDiff ? <DiffView diff={turnDiff} /> : <p className="muted">{t('diff.none')}</p>}
      <h3 className="section-title" style={{ marginTop: 14 }}>
        {t('diff.git')}
      </h3>
      {gitDiff ? <DiffView diff={gitDiff} /> : gitDiff === '' ? <p className="muted">{t('diff.clean')}</p> : <p className="muted">{t('diff.notGit')}</p>}
      {gitError ? <p className="muted mono" style={{ fontSize: 12 }}>{gitError}</p> : null}
    </>
  );
}

export function DiffDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<{ turnDiff: string | null; gitDiff: string | null; gitError: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<typeof data>(`/api/sessions/${sessionId}/diff`).then(setData).catch(setError);
  }, [sessionId]);
  return (
    <Modal title={t('diff.title')} onClose={onClose} wide>
      <ErrorAlert error={error} />
      {data ? <DiffBlock {...data} /> : error ? null : <Spinner />}
    </Modal>
  );
}

function StatusBody({ status }: { status: SessionStatus }) {
  const { t, lang } = useI18n();
  const e = status.effective;
  return (
    <>
      <dl className="facts">
        <dt>{t('session.model')}</dt>
        <dd>{e.model ?? t('session.defaultModel')}</dd>
        <dt>{t('session.effort')}</dt>
        <dd>{e.effort ?? t('session.defaultModel')}</dd>
        <dt>{t('settings.sandbox')}</dt>
        <dd>{t(`sandbox.${e.sandbox}`)}</dd>
        <dt>{t('settings.approvalPolicy')}</dt>
        <dd>{t(`approvalPolicy.${e.approvalPolicy}`)}</dd>
        <dt>{t('settings.network')}</dt>
        <dd>{e.networkAccess ? t('codex.networkOn') : t('codex.networkOff')}</dd>
        <dt>{t('sessionStatus.contextWindow')}</dt>
        <dd>{status.contextWindow ? t('sessionStatus.tokensN', { n: fmtCompact(lang, status.contextWindow) }) : '—'}</dd>
        <dt>{t('sessionStatus.lastTurn')}</dt>
        <dd>
          {status.lastTurnTokens
            ? t('turn.tokens', { input: fmtCompact(lang, status.lastTurnTokens.inputTokens), output: fmtCompact(lang, status.lastTurnTokens.outputTokens) })
            : '—'}
        </dd>
        <dt>{t('sessionStatus.threadTokens')}</dt>
        <dd>
          {status.totalTokens
            ? t('turn.tokens', { input: fmtCompact(lang, status.totalTokens.input), output: fmtCompact(lang, status.totalTokens.output) })
            : '—'}
        </dd>
        <dt>{t('goal.label')}</dt>
        <dd>
          {status.goal ? (
            <>
              {status.goal.objective} <GoalStatus status={status.goal.status} />
            </>
          ) : (
            t('common.none')
          )}
        </dd>
        <dt>{t('sessionStatus.waiting')}</dt>
        <dd>{t('sessionStatus.waitingCounts', { approvals: status.pendingApprovals, questions: status.pendingQuestions })}</dd>
      </dl>
      {status.rateLimits?.primary ? (
        <div style={{ marginTop: 14 }}>
          <LimitMeter label={t('codex.limitPrimary')} window={status.rateLimits.primary} />
          {status.rateLimits.secondary ? <LimitMeter label={t('codex.limitSecondary')} window={status.rateLimits.secondary} /> : null}
        </div>
      ) : null}
    </>
  );
}

export function StatusDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<SessionStatus>(`/api/sessions/${sessionId}/status`).then(setStatus).catch(setError);
  }, [sessionId]);
  return (
    <Modal title={t('sessionStatus.title')} onClose={onClose}>
      <ErrorAlert error={error} />
      {status ? <StatusBody status={status} /> : error ? null : <Spinner />}
    </Modal>
  );
}

export function GoalDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [goal, setGoal] = useState<ThreadGoal | null | undefined>(undefined);
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<{ goal: ThreadGoal | null }>(`/api/sessions/${sessionId}/goal`)
      .then((r) => {
        setGoal(r.goal);
        setObjective(r.goal?.objective ?? '');
      })
      .catch(setError);
  }, [sessionId]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ goal: ThreadGoal | null }>(`/api/sessions/${sessionId}/goal`, { objective: objective.trim(), tokenBudget: budget ? Number(budget) : null });
      setGoal(r.goal);
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t('goal.title')} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('goal.body')}
      </p>
      {goal ? (
        <p>
          <GoalStatus status={goal.status} />{' '}
          {t('goal.progress', { tokens: fmtCompact(lang, goal.tokensUsed), time: fmtDuration(t, goal.timeUsedSeconds * 1000) })}
        </p>
      ) : null}
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="goal-objective">{t('goal.objective')}</label>
          <textarea id="goal-objective" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} required maxLength={4000} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="goal-budget">{t('goal.budget')}</label>
          <input id="goal-budget" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="200000" />
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          {goal ? (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                try {
                  await del(`/api/sessions/${sessionId}/goal`);
                  onClose();
                } catch (err) {
                  setError(err);
                }
              }}
            >
              {t('goal.clear')}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!objective.trim()}>
            {t('goal.set')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Shows the result of a slash command that doesn't start a turn. */
export function CommandResultDialog({ result, onClose }: { result: CommandResult; onClose: () => void }) {
  const { t } = useI18n();
  const title =
    result.kind === 'help'
      ? t('commands.title')
      : result.kind === 'models'
        ? t('session.model')
        : result.kind === 'skills'
          ? t('skills.title')
          : result.kind === 'mcp'
            ? t('mcp.title')
            : result.kind === 'status'
              ? t('sessionStatus.title')
              : result.kind === 'diff'
                ? t('diff.title')
                : result.kind === 'goal'
                  ? t('goal.title')
                  : t('commands.done');
  return (
    <Modal title={title} onClose={onClose} wide={result.kind === 'diff'}>
      {result.kind === 'help' ? (
        <table className="data">
          <tbody>
            {result.commands.map((c) => (
              <tr key={c.name}>
                <td className="mono nowrap">
                  {c.name} {c.args}
                </td>
                <td>{t(commandKey(c.name))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : result.kind === 'models' ? (
        <ul>
          {result.models.map((m) => (
            <li key={m.id}>
              <strong className="mono">{m.id}</strong> {m.id === result.current ? <span className="badge info">{t('common.current')}</span> : null} — {m.description}
            </li>
          ))}
        </ul>
      ) : result.kind === 'skills' ? (
        <ul>
          {result.skills.map((s) => (
            <li key={s.path}>
              <strong>{s.name}</strong> <span className="muted">({s.scope})</span> — {s.description}
            </li>
          ))}
        </ul>
      ) : result.kind === 'mcp' ? (
        result.servers.length === 0 ? (
          <p className="muted">{t('mcp.empty')}</p>
        ) : (
          <ul>
            {result.servers.map((s) => (
              <li key={s.name}>
                <strong className="mono">{s.name}</strong> <span className="badge">{s.runtimeStatus ?? '—'}</span> {s.tools.map((x) => x.name).join(', ')}
              </li>
            ))}
          </ul>
        )
      ) : result.kind === 'status' ? (
        <StatusBody status={result.status} />
      ) : result.kind === 'diff' ? (
        <DiffBlock turnDiff={result.turnDiff} gitDiff={result.gitDiff} gitError={result.gitError} />
      ) : result.kind === 'goal' ? (
        <p>
          {result.goal ? (
            <>
              {result.goal.objective} <GoalStatus status={result.goal.status} />
            </>
          ) : (
            t('goal.none')
          )}
        </p>
      ) : (
        <p>{t('commands.done')}</p>
      )}
    </Modal>
  );
}

/** Translation key for a slash command's description. */
export function commandKey(name: string) {
  const map = {
    '/help': 'cmd.help',
    '/new': 'cmd.new',
    '/fork': 'cmd.fork',
    '/undo': 'cmd.undo',
    '/model': 'cmd.model',
    '/approvals': 'cmd.approvals',
    '/sandbox': 'cmd.sandbox',
    '/network': 'cmd.network',
    '/review': 'cmd.review',
    '/compact': 'cmd.compact',
    '/diff': 'cmd.diff',
    '/init': 'cmd.init',
    '/skills': 'cmd.skills',
    '/status': 'cmd.status',
    '/mcp': 'cmd.mcp',
    '/goal': 'cmd.goal',
    '/mention': 'cmd.mention',
    '!': 'cmd.shell',
  } as const;
  return map[name as keyof typeof map] ?? 'cmd.help';
}

export const COMPOSER_COMMANDS = [
  '/help', '/new', '/fork', '/undo', '/model', '/approvals', '/sandbox', '/network', '/review', '/compact', '/diff', '/init', '/mention', '/skills', '/status', '/mcp', '/goal', '!',
];

/** Fuzzy file search inside the session folder, for @-mentions. */
export function MentionDialog({ sessionId, onClose, onPick }: { sessionId: string; onClose: () => void; onPick: (f: { path: string; name: string }) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<Array<{ path: string; name: string }>>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!q.trim()) {
      setFiles([]);
      return;
    }
    const timer = setTimeout(() => {
      get<{ files: Array<{ path: string; name: string }> }>(`/api/sessions/${sessionId}/search${qs({ q: q.trim() })}`)
        .then((r) => {
          setFiles(r.files);
          setError(null);
        })
        .catch(setError);
    }, 200);
    return () => clearTimeout(timer);
  }, [q, sessionId]);
  return (
    <Modal title={t('mention.title')} onClose={onClose}>
      <div className="field">
        <label htmlFor="mention-q">{t('mention.search')}</label>
        <input id="mention-q" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder={t('mention.placeholder')} />
      </div>
      <ErrorAlert error={error} />
      <ul className="thread-list">
        {files.map((f) => (
          <li key={f.path}>
            <div className="info">
              <div>{f.name}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                {f.path}
              </div>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                onPick(f);
                onClose();
              }}
            >
              {t('mention.add')}
            </button>
          </li>
        ))}
      </ul>
      {q.trim() && files.length === 0 && !error ? <p className="muted">{t('mention.none')}</p> : null}
    </Modal>
  );
}

export function SkillsDialog({ sessionId, onClose, onPick }: { sessionId: string; onClose: () => void; onPick: (s: SkillInfo) => void }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<{ skills: SkillInfo[] }>(`/api/sessions/${sessionId}/skills`)
      .then((r) => setSkills(r.skills))
      .catch(setError);
  }, [sessionId]);
  return (
    <Modal title={t('skills.title')} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('skills.body')}
      </p>
      <ErrorAlert error={error} />
      {skills === null ? (
        error ? null : <Spinner />
      ) : skills.length === 0 ? (
        <p className="muted">{t('skills.none')}</p>
      ) : (
        <ul className="thread-list">
          {skills.map((s) => (
            <li key={s.path}>
              <div className="info">
                <div>
                  <strong>{s.name}</strong> <span className="muted">({s.scope})</span>
                </div>
                <div className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>
                  {s.description}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={!s.enabled}
                onClick={() => {
                  onPick(s);
                  onClose();
                }}
              >
                {t('skills.use')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function ImageUrlDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (url: string) => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const valid = /^https:\/\/\S+$/i.test(url.trim());
  return (
    <Modal title={t('imageUrl.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onAdd(url.trim());
          onClose();
        }}
      >
        <div className="field">
          <label htmlFor="image-url">{t('imageUrl.label')}</label>
          <input id="image-url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('imageUrl.placeholder')} autoFocus />
          <span className="hint">{t('imageUrl.hint')}</span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            {t('mention.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
