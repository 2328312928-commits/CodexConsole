import { useEffect, useState, type FormEvent } from 'react';
import type { ModelInfo } from '../../../../shared/api.js';
import type { MessageKey } from '../../../../shared/i18n/index.js';
import { get, post, put } from '../../api';
import { useCodexStatus } from '../../codexStatus';
import { CopyButton, ErrorAlert, InfoTip, Modal, Spinner } from '../../components/ui';
import { fmtCompact, fmtDuration, fmtNumber } from '../../format';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../../icons';
import { effortLabel } from '../console/ModelPicker';
import { FeedbackDialog } from '../console/SessionTools';
import { useAdminData } from './common';

type Any = Record<string, any>;

function Card({ id, icon, title, actions, children }: { id?: string; icon: IconName; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card codex-card" id={id}>
      <h2 className="section-title">
        <Icon name={icon} /> {title}
        <span className="spacer" />
        {actions}
      </h2>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Unavailable({ data }: { data: Any | null }) {
  const { t } = useI18n();
  if (!data?.unavailable) return null;
  return (
    <p className="muted small-text">
      {t('codexAdmin.unavailable')} <InfoTip text={String(data.unavailable)} />
    </p>
  );
}

// ---- account ----

function AccountCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const status = useCodexStatus();
  const acct = useAdminData<Any>('/api/admin/codex/account', onAdminLost, 30_000);
  const [login, setLogin] = useState<{ url: string | null; userCode: string | null; loginId: string | null } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const a = acct.data;
  const usage = a?.usage && !a.usage.unavailable ? a.usage : null;
  const days: Array<{ startDate: string; tokens: number }> = usage?.dailyUsageBuckets ?? [];
  const peak = Math.max(1, ...days.map((d) => d.tokens));
  const refresh = async () => {
    await acct.reload();
    await status.refresh();
  };
  return (
    <Card icon="user" title={t('codexAdmin.account')}>
      {!a ? (
        <ErrorAlert error={acct.error} />
      ) : (
        <>
          <div className="account-row">
            <div className="avatar">
              <Icon name="user" size={18} />
            </div>
            <div className="grow">
              <div className="strong">{a.account?.email ?? (a.signedIn ? t('overview.accountChatgpt', { plan: a.account?.planType ?? '' }) : t('overview.accountNone'))}</div>
              <div className="muted small-text">{a.account?.planType ? t('codex.plan', { plan: a.account.planType }) : null}</div>
            </div>
            {a.signedIn ? (
              <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => {
                await post('/api/admin/codex/logout');
                await refresh();
              })}>
                {t('codexAdmin.signOut')}
              </button>
            ) : (
              <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(async () => setLogin(await post('/api/admin/codex/login', { mode: 'deviceCode' })))}>
                {t('codexAdmin.signIn')}
              </button>
            )}
          </div>
          {usage ? (
            <>
              <div className="kpis compact">
                <div className="kpi">
                  <div className="k-label">{t('codexAdmin.lifetime')}</div>
                  <div className="k-value">{fmtCompact(lang, usage.summary?.lifetimeTokens ?? 0)}</div>
                </div>
                <div className="kpi">
                  <div className="k-label">{t('codexAdmin.peakDay')}</div>
                  <div className="k-value">{fmtCompact(lang, usage.summary?.peakDailyTokens ?? 0)}</div>
                </div>
                <div className="kpi">
                  <div className="k-label">{t('codexAdmin.streak')}</div>
                  <div className="k-value">{fmtNumber(lang, usage.summary?.currentStreakDays ?? 0)}</div>
                </div>
                <div className="kpi">
                  <div className="k-label">{t('codexAdmin.longestTurn')}</div>
                  <div className="k-value">{fmtDuration(t, (usage.summary?.longestRunningTurnSec ?? 0) * 1000)}</div>
                </div>
              </div>
              {days.length ? (
                <div className="spark" role="img" aria-label={t('codexAdmin.daily')}>
                  {[...days].reverse().map((d) => (
                    <span key={d.startDate} title={`${d.startDate}: ${fmtNumber(lang, d.tokens)}`} style={{ height: `${Math.max(6, (d.tokens / peak) * 100)}%` }} />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {a.signedIn ? (
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => {
                setOutcome((await post<{ outcome: string | null }>('/api/admin/codex/limit-reset')).outcome);
                await refresh();
              })}>
                <Icon name="refresh" size={14} />
                {t('codexAdmin.useReset')}
              </button>
              {outcome ? <span className="muted small-text">{t(`codexAdmin.reset.${outcome}` as MessageKey)}</span> : null}
            </div>
          ) : null}
          <ErrorAlert error={error} />
        </>
      )}
      {login ? (
        <Modal
          title={t('codexAdmin.signIn')}
          onClose={() => {
            setLogin(null);
            void refresh();
          }}
        >
          {login.userCode ? <div className="pair-code">{login.userCode}</div> : null}
          {login.url ? (
            <div className="row" style={{ marginTop: 12 }}>
              <code className="url-box">{login.url}</code>
              <CopyButton text={login.url} />
              <a className="btn small primary" href={login.url} target="_blank" rel="noopener noreferrer">
                <Icon name="link" size={14} />
                {t('question.openLink')}
              </a>
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => void refresh().then(() => setLogin(null))}>
              {t('codexAdmin.done')}
            </button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

// ---- defaults (config.toml) ----

const DEFAULT_KEYS = ['model', 'model_reasoning_effort', 'model_reasoning_summary', 'service_tier', 'web_search', 'approvals_reviewer'] as const;

function DefaultsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const cfg = useAdminData<Any>('/api/admin/codex/config', onAdminLost);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    get<{ models: ModelInfo[] }>('/api/codex/models')
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);
  useEffect(() => {
    if (!cfg.data) return;
    const c = cfg.data.config ?? {};
    setForm(Object.fromEntries(DEFAULT_KEYS.map((k) => [k, typeof c[k] === 'string' ? c[k] : ''])));
  }, [cfg.data]);
  const model = models.find((m) => m.id === form.model) ?? models.find((m) => m.isDefault);
  const select = (key: string, label: string, options: Array<[string, string]>) => (
    <div className="field">
      <label htmlFor={`cd-${key}`}>{label}</label>
      <select id={`cd-${key}`} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value, ...(key === 'model' ? { model_reasoning_effort: '', service_tier: '' } : {}) })}>
        <option value="">{t('settings.codexChooses')}</option>
        {form[key] && !options.some(([v]) => v === form[key]) ? <option value={form[key]}>{form[key]}</option> : null}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await put('/api/admin/codex/config', { edits: DEFAULT_KEYS.map((k) => ({ keyPath: k, value: form[k] || null })) });
      await cfg.reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    });
  };
  return (
    <Card icon="sliders" title={t('settings.codexDefaults')}>
      {!cfg.data ? (
        cfg.error ? <ErrorAlert error={cfg.error} /> : <Spinner />
      ) : (
        <form onSubmit={save}>
          <div className="grid-2 tight">
            {select('model', t('session.model'), models.map((m) => [m.id, m.displayName]))}
            {select('model_reasoning_effort', t('picker.reasoning'), (model?.efforts ?? []).map((x) => [x, effortLabel(t, x)]))}
            {select('model_reasoning_summary', t('picker.summary'), (['auto', 'concise', 'detailed', 'none'] as const).map((x) => [x, t(`summary.${x}`)]))}
            {select('service_tier', t('picker.speed'), (model?.serviceTiers ?? []).map((x) => [x.id, x.name]))}
            {select('web_search', t('settings.webSearch'), (['disabled', 'cached', 'live'] as const).map((x) => [x, t(`webSearch.${x}`)]))}
            {select('approvals_reviewer', t('settings.reviewer'), [['user', t('reviewer.user')], ['auto_review', t('reviewer.auto')]])}
          </div>
          <ErrorAlert error={error} />
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy}>
              {t('common.save')}
            </button>
            {saved ? (
              <span className="muted" role="status">
                <Icon name="check" size={14} /> {t('common.saved')}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </Card>
  );
}

// ---- features ----

function FeaturesCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<{ features: Any[] }>('/api/admin/codex/features', onAdminLost);
  const [showAll, setShowAll] = useState(false);
  const { busy, error, run } = useAction();
  const list = (data.data?.features ?? []).filter((f) => f.stage !== 'removed' && (showAll || f.stage !== 'underDevelopment'));
  return (
    <Card
      id="experimental"
      icon="flask"
      title={t('codexAdmin.features')}
      actions={
        <label className="checkbox small-text">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {t('codexAdmin.showInDevelopment')}
        </label>
      }
    >
      <ErrorAlert error={data.error ?? error} />
      {!data.data ? (
        <Spinner />
      ) : (
        <ul className="list-rows">
          {list.map((f) => (
            <li key={f.name}>
              <div className="grow">
                <div className="strong">
                  {f.displayName || f.name} <span className={`badge ${f.stage === 'stable' ? '' : 'info'}`}>{t(`stage.${f.stage}` as MessageKey)}</span>
                </div>
                {f.description ? <div className="muted small-text">{f.description}</div> : <div className="muted small-text mono">{f.name}</div>}
              </div>
              <Switch
                checked={Boolean(f.enabled)}
                label={f.displayName || f.name}
                disabled={busy}
                onChange={(v) => void run(async () => {
                  await put('/api/admin/codex/features', { enablement: { [f.name]: v } });
                  await data.reload();
                })}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- plugins & apps ----

function PluginsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<Any>('/api/admin/codex/plugins', onAdminLost);
  const { busy, error, run } = useAction();
  const markets: Any[] = data.data?.marketplaces ?? [];
  return (
    <Card id="plugins" icon="puzzle" title={t('codexAdmin.plugins')}>
      <ErrorAlert error={data.error ?? error} />
      <Unavailable data={data.data} />
      {!data.data ? (
        <Spinner />
      ) : markets.every((m) => !m.plugins?.length) ? (
        <p className="empty compact">{t('codexAdmin.noPlugins')}</p>
      ) : (
        markets.map((m) => (
          <div key={m.name}>
            <div className="picker-section">{m.interface?.displayName ?? m.name}</div>
            <ul className="list-rows">
              {(m.plugins ?? []).map((p: Any) => (
                <li key={p.id}>
                  <div className="grow">
                    <div className="strong">{p.interface?.displayName ?? p.name}</div>
                    {p.interface?.shortDescription ? <div className="muted small-text">{p.interface.shortDescription}</div> : null}
                  </div>
                  {p.installed ? (
                    <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => {
                      await post('/api/admin/codex/plugins/uninstall', { pluginId: p.id });
                      await data.reload();
                    })}>
                      {t('codexAdmin.uninstall')}
                    </button>
                  ) : (
                    <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(async () => {
                      await post('/api/admin/codex/plugins/install', { pluginName: p.name, marketplacePath: m.path ?? null, remoteMarketplaceName: m.path ? null : m.name });
                      await data.reload();
                    })}>
                      {t('codexAdmin.install')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Card>
  );
}

function AppsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<Any>('/api/admin/codex/apps', onAdminLost);
  const apps: Any[] = data.data?.data ?? [];
  return (
    <Card id="apps" icon="layers" title={t('codexAdmin.apps')}>
      <ErrorAlert error={data.error} />
      <Unavailable data={data.data} />
      {!data.data ? (
        <Spinner />
      ) : apps.length === 0 && !data.data.unavailable ? (
        <p className="empty compact">{t('codexAdmin.noApps')}</p>
      ) : (
        <ul className="list-rows">
          {apps.map((a) => (
            <li key={a.id}>
              <div className="grow">
                <div className="strong">{a.name}</div>
                {a.description ? <div className="muted small-text">{a.description}</div> : null}
              </div>
              <span className={`badge ${a.isEnabled ? 'good' : ''}`}>{a.isEnabled ? t('common.on') : t('common.off')}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- skills, hooks, memories, import ----

function SkillsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<{ skills: Any[] }>('/api/admin/codex/skills', onAdminLost);
  const { busy, error, run } = useAction();
  return (
    <Card icon="sparkle" title={t('skills.title')}>
      <ErrorAlert error={data.error ?? error} />
      {!data.data ? (
        <Spinner />
      ) : data.data.skills.length === 0 ? (
        <p className="empty compact">{t('skills.none')}</p>
      ) : (
        <ul className="list-rows">
          {data.data.skills.map((s) => (
            <li key={s.path}>
              <div className="grow">
                <div className="strong">
                  {s.name} <span className="badge">{s.scope}</span>
                </div>
                <div className="muted small-text">{s.description}</div>
              </div>
              <Switch
                checked={Boolean(s.enabled)}
                label={s.name}
                disabled={busy}
                onChange={(v) => void run(async () => {
                  await post('/api/admin/codex/skills', { path: s.path, enabled: v });
                  await data.reload();
                })}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HooksCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<{ data: Any[] }>('/api/admin/codex/hooks', onAdminLost);
  const hooks = (data.data?.data ?? []).flatMap((e) => (e.hooks ?? []).map((h: Any) => ({ ...h, cwd: e.cwd })));
  const problems = (data.data?.data ?? []).flatMap((e) => [...(e.errors ?? []), ...(e.warnings ?? [])]);
  return (
    <Card id="hooks" icon="link" title={t('codexAdmin.hooks')}>
      <ErrorAlert error={data.error} />
      {!data.data ? (
        <Spinner />
      ) : hooks.length === 0 ? (
        <p className="empty compact">{t('codexAdmin.noHooks')}</p>
      ) : (
        <ul className="list-rows">
          {hooks.map((h, i) => (
            <li key={i}>
              <div className="grow">
                <div className="strong">{h.event ?? h.handlerType}</div>
                <div className="muted small-text mono clip-text">{h.command ?? h.tool ?? h.server ?? JSON.stringify(h)}</div>
              </div>
              <span className="badge">{h.handlerType}</span>
            </li>
          ))}
        </ul>
      )}
      {problems.length ? <pre className="log">{problems.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')}</pre> : null}
    </Card>
  );
}

function MemoriesCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const data = useAdminData<Any>('/api/admin/codex/memory', onAdminLost);
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Card id="memories" icon="brain" title={t('codexAdmin.memories')}>
      <ErrorAlert error={data.error ?? error} />
      <Unavailable data={data.data} />
      {data.data && !data.data.unavailable ? (
        <div className="account-row">
          <div className="grow">
            <div className="k-value">{fmtNumber(lang, data.data.v2ConsolidatedThreads ?? 0)}</div>
            <div className="muted small-text">{t('codexAdmin.memoryThreads')}</div>
          </div>
          <span className={`badge ${data.data.v2Ready ? 'good' : ''}`}>{data.data.v2Ready ? t('codexAdmin.ready') : t('codexAdmin.notReady')}</span>
          {confirm ? (
            <button type="button" className="btn small danger solid" disabled={busy} onClick={() => void run(async () => {
              await post('/api/admin/codex/memory/reset');
              setConfirm(false);
              await data.reload();
            })}>
              {t('codexAdmin.confirmReset')}
            </button>
          ) : (
            <button type="button" className="btn small danger" onClick={() => setConfirm(true)}>
              {t('codexAdmin.resetMemories')}
            </button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ImportCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const data = useAdminData<Any>('/api/admin/codex/import', onAdminLost);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const items: Any[] = data.data?.items ?? [];
  return (
    <Card icon="download" title={t('codexAdmin.import')}>
      <ErrorAlert error={data.error ?? error} />
      <Unavailable data={data.data} />
      {!data.data ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="empty compact">{t('codexAdmin.nothingToImport')}</p>
      ) : (
        <>
          <ul className="list-rows">
            {items.map((it, i) => (
              <li key={i}>
                <label className="checkbox grow">
                  <input type="checkbox" checked={picked.has(i)} onChange={(e) => setPicked((p) => {
                    const n = new Set(p);
                    if (e.target.checked) n.add(i);
                    else n.delete(i);
                    return n;
                  })} />
                  <span>{it.description}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn small primary" disabled={busy || picked.size === 0} onClick={() => void run(async () => {
              await post('/api/admin/codex/import', { items: items.filter((_, i) => picked.has(i)) });
              setDone(true);
              setPicked(new Set());
            })}>
              {t('codexAdmin.importSelected')}
            </button>
            {done ? (
              <span className="muted small-text">
                <Icon name="check" size={13} /> {t('codexAdmin.imported')}
              </span>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

// ---- config & diagnostics ----

function ConfigCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const cfg = useAdminData<Any>('/api/admin/codex/config', onAdminLost);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const { busy, error, run } = useAction();
  const [parseError, setParseError] = useState(false);
  const layers: Any[] = cfg.data?.layers ?? [];
  return (
    <Card icon="file" title={t('codexAdmin.config')}>
      <ErrorAlert error={cfg.error ?? error} />
      {cfg.data ? (
        <>
          <div className="tag-list" style={{ marginBottom: 10 }}>
            {layers.map((l, i) => (
              <span key={i} className={`badge ${l.disabledReason ? 'warn' : ''}`} title={l.name?.file ?? l.disabledReason ?? undefined}>
                {l.name?.type}
                {l.name?.profile ? `:${l.name.profile}` : ''}
              </span>
            ))}
          </div>
          <details className="advanced">
            <summary>{t('codexAdmin.effectiveConfig')}</summary>
            <pre className="log config-view">{JSON.stringify(cfg.data.config, null, 2)}</pre>
          </details>
          <form
            className="config-edit"
            onSubmit={(e) => {
              e.preventDefault();
              let parsed: unknown;
              try {
                parsed = value.trim() === '' ? null : JSON.parse(value);
              } catch {
                parsed = value;
              }
              setParseError(false);
              void run(async () => {
                await put('/api/admin/codex/config', { edits: [{ keyPath: key.trim(), value: parsed }] });
                await cfg.reload();
                setValue('');
              });
            }}
          >
            <input aria-label={t('codexAdmin.keyPath')} className="mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('codexAdmin.keyPathPlaceholder')} spellCheck={false} />
            <input aria-label={t('codexAdmin.value')} className="mono grow" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('codexAdmin.valuePlaceholder')} spellCheck={false} aria-invalid={parseError} />
            <button type="submit" className="btn primary" disabled={busy || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key.trim())}>
              {t('common.save')}
            </button>
          </form>
        </>
      ) : cfg.error ? null : (
        <Spinner />
      )}
    </Card>
  );
}

function DiagnosticsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const warnings = useAdminData<{ warnings: Array<{ at: number; kind: string; message: string }> }>('/api/admin/codex/warnings', onAdminLost, 30_000);
  const [report, setReport] = useState<{ ok: boolean; output: string } | null>(null);
  const [feedback, setFeedback] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Card
      icon="activity"
      title={t('codexAdmin.diagnostics')}
      actions={
        <>
          <button type="button" className="btn small" onClick={() => setFeedback(true)}>
            <Icon name="message" size={14} />
            {t('session.feedback')}
          </button>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(async () => setReport(await post('/api/admin/codex/doctor')))}>
            {busy ? <span className="spinner" /> : <Icon name="activity" size={14} />}
            {t('codexAdmin.runDoctor')}
          </button>
        </>
      }
    >
      <ErrorAlert error={error} />
      {report ? <pre className={`log doctor ${report.ok ? '' : 'bad'}`}>{report.output}</pre> : null}
      {warnings.data?.warnings.length ? (
        <ul className="list-rows">
          {warnings.data.warnings.map((w, i) => (
            <li key={i}>
              <Icon name="alert" size={14} />
              <div className="grow">
                <div className="small-text">{w.message}</div>
                <div className="muted small-text mono">{w.kind}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : !report ? (
        <p className="empty compact">{t('codexAdmin.noWarnings')}</p>
      ) : null}
      {feedback ? <FeedbackDialog url="/api/admin/codex/feedback" onClose={() => setFeedback(false)} /> : null}
    </Card>
  );
}

export function CodexTab({ onAdminLost }: { onAdminLost: () => void }) {
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }, []);
  return (
    <div className="codex-admin">
      <div className="grid-2">
        <AccountCard onAdminLost={onAdminLost} />
        <DefaultsCard onAdminLost={onAdminLost} />
      </div>
      <FeaturesCard onAdminLost={onAdminLost} />
      <div className="grid-2">
        <PluginsCard onAdminLost={onAdminLost} />
        <AppsCard onAdminLost={onAdminLost} />
      </div>
      <div className="grid-2">
        <SkillsCard onAdminLost={onAdminLost} />
        <HooksCard onAdminLost={onAdminLost} />
      </div>
      <div className="grid-2">
        <MemoriesCard onAdminLost={onAdminLost} />
        <ImportCard onAdminLost={onAdminLost} />
      </div>
      <ConfigCard onAdminLost={onAdminLost} />
      <DiagnosticsCard onAdminLost={onAdminLost} />
    </div>
  );
}
