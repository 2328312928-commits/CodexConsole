import { useState, type FormEvent } from 'react';
import {
  API_KEY_SCOPES,
  DANGEROUS_SCOPES,
  QUOTA_PERIODS,
  type ApiKeyInfo,
  type ApiKeyLimits,
  type ApiKeyScope,
  type ApiKeySecret,
  type ApiKeyUsage,
  type KeyApprovals,
  type QuotaPeriod,
} from '../../../../shared/api.js';
import type { SandboxMode } from '../../../../shared/codex.js';
import { patch, post } from '../../api';
import { limitSeverity } from '../../codexStatus';
import { ConfirmDialog, CopyButton, ErrorAlert, Modal, Spinner } from '../../components/ui';
import { fmtBytes, fmtCompact, fmtDateTime, fmtDuration, fmtNumber, fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { navigate } from '../../router';
import { DailyColumns } from './charts';
import { useAdminData } from './common';
import { statusTone } from './RequestsTab';

const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const EXPIRY_DAYS = [7, 30, 90, 365];
const DEFAULT_LIMITS: ApiKeyLimits = { perMinute: 60, promptsPerMinute: 6, concurrent: 2, uploadMbPerHour: 500 };
const DANGER = new Set<ApiKeyScope>(DANGEROUS_SCOPES);

interface KeyForm {
  label: string;
  scopes: ApiKeyScope[];
  quotaTokens: string;
  quotaPeriod: QuotaPeriod;
  /** '' keeps the current expiry (edit), 'never', or a number of days from now. */
  expiry: string;
  maxSandbox: SandboxMode;
  allowNetwork: boolean;
  approvals: KeyApprovals;
  limits: ApiKeyLimits;
  ipAllowlist: string;
  folder: string;
}

function blankForm(): KeyForm {
  return {
    label: '',
    scopes: ['prompt', 'sessions', 'files:read', 'files:write'],
    quotaTokens: '1000000',
    quotaPeriod: 'month',
    expiry: '90',
    maxSandbox: 'workspace-write',
    allowNetwork: false,
    approvals: 'deny',
    limits: { ...DEFAULT_LIMITS },
    ipAllowlist: '',
    folder: '',
  };
}

function formFromKey(k: ApiKeyInfo): KeyForm {
  return {
    label: k.label,
    scopes: k.scopes,
    quotaTokens: k.quota.tokens === null ? '' : String(k.quota.tokens),
    quotaPeriod: k.quota.period,
    expiry: '',
    maxSandbox: k.maxSandbox,
    allowNetwork: k.allowNetwork,
    approvals: k.approvals,
    limits: { ...k.limits },
    ipAllowlist: k.ipAllowlist.join('\n'),
    folder: k.folder,
  };
}

function keyTone(s: ApiKeyInfo['status']): string {
  return s === 'active' ? 'good' : s === 'expired' ? 'warn' : 'bad';
}

/** Explains what keys are for and whether the public listener is on. */
function ApiStatus({ api }: { api: { enabled: boolean; baseUrl: string } }) {
  const { t } = useI18n();
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2 className="section-title">
        <Icon name="globe" /> {t('keys.publicApi')}
        <span className={`badge ${api.enabled ? 'good' : ''}`}>{api.enabled ? t('keys.apiOn') : t('keys.apiOff')}</span>
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('keys.intro')}
      </p>
      {api.enabled ? (
        <div className="row">
          <code className="url-box">{`${api.baseUrl}/v1`}</code>
          <CopyButton text={`${api.baseUrl}/v1`} />
        </div>
      ) : (
        <div className="alert">
          <Icon name="info" />
          <div>{t('keys.apiOffHint')}</div>
        </div>
      )}
    </section>
  );
}

function QuotaMeter({ k }: { k: ApiKeyInfo }) {
  const { t, lang } = useI18n();
  const periodLabel = t(`keys.period.${k.quota.period}`);
  if (k.quota.tokens === null) {
    return (
      <div>
        <div>{t('keys.quotaUnlimited')}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {t('keys.quotaUsed', { used: fmtCompact(lang, k.quota.used), period: periodLabel })}
        </div>
      </div>
    );
  }
  const pct = Math.min(100, (k.quota.used / k.quota.tokens) * 100);
  const sev = limitSeverity(pct);
  return (
    <div className={`quota-meter ${sev}`}>
      <div>
        {sev ? <Icon name="alert" size={13} /> : null} {fmtCompact(lang, k.quota.used)} / {fmtCompact(lang, k.quota.tokens)} · {periodLabel}
      </div>
      <div className="m-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t('keys.quota')}>
        <div className="m-fill" style={{ width: `${pct}%` }} />
      </div>
      {k.quota.resetsAt ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {t('keys.quotaResets', { time: fmtRelative(lang, t, k.quota.resetsAt) })}
        </div>
      ) : null}
    </div>
  );
}

function KeyFormDialog({ edit, onClose, onCreated, onSaved }: { edit: ApiKeyInfo | null; onClose: () => void; onCreated: (s: ApiKeySecret) => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<KeyForm>(() => (edit ? formFromKey(edit) : blankForm()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof KeyForm>(k: K, v: KeyForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setLimit = (k: keyof ApiKeyLimits, v: string) => setForm((f) => ({ ...f, limits: { ...f.limits, [k]: Number(v) } }));
  const toggleScope = (s: ApiKeyScope) => set('scopes', form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const settings = {
      label: form.label.trim(),
      scopes: API_KEY_SCOPES.filter((s) => form.scopes.includes(s)),
      quotaTokens: form.quotaTokens.trim() ? Number(form.quotaTokens) : null,
      quotaPeriod: form.quotaPeriod,
      maxSandbox: form.maxSandbox,
      allowNetwork: form.allowNetwork,
      approvals: form.approvals,
      limits: form.limits,
      ipAllowlist: form.ipAllowlist
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    };
    try {
      if (edit) {
        const expiresAt = form.expiry === '' ? undefined : form.expiry === 'never' ? null : Date.now() + Number(form.expiry) * 86_400_000;
        await patch(`/api/admin/api-keys/${edit.id}`, { ...settings, ...(expiresAt !== undefined ? { expiresAt } : {}) });
        onSaved();
      } else {
        onCreated(
          await post<ApiKeySecret>('/api/admin/api-keys', {
            ...settings,
            expiresInDays: form.expiry === 'never' ? null : Number(form.expiry),
            ...(form.folder.trim() ? { folder: form.folder.trim() } : {}),
          }),
        );
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const dangerous = form.scopes.filter((s) => DANGER.has(s));
  return (
    <Modal title={edit ? t('keys.editTitle', { label: edit.label }) : t('keys.createTitle')} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="grid-2 tight">
          <div className="field">
            <label htmlFor="key-label">{t('keys.label')}</label>
            <input id="key-label" value={form.label} onChange={(e) => set('label', e.target.value)} maxLength={60} required placeholder={t('keys.labelPlaceholder')} />
          </div>
          <div className="field">
            <label htmlFor="key-expiry">{t('devices.expires')}</label>
            <select id="key-expiry" value={form.expiry} onChange={(e) => set('expiry', e.target.value)}>
              {edit ? <option value="">{t('keys.expiryKeep', { when: edit.expiresAt ? fmtDateTime(lang, edit.expiresAt) : t('devices.expiresNever') })}</option> : null}
              <option value="never">{t('devices.expiresNever')}</option>
              {EXPIRY_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  {t('devices.expiresDays', { days: d })}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="field">
          <legend>{t('keys.scopes')}</legend>
          <div className="scope-grid">
            {API_KEY_SCOPES.map((s) => (
              <label key={s} className={`checkbox scope ${DANGER.has(s) ? 'danger' : ''}`}>
                <input type="checkbox" checked={form.scopes.includes(s)} onChange={() => toggleScope(s)} />
                <span>
                  <span className="mono">{s}</span>
                  {DANGER.has(s) ? <Icon name="alert" size={13} /> : null}
                  <small className="muted">{t(`keys.scope.${s}`)}</small>
                </span>
              </label>
            ))}
          </div>
          {dangerous.length > 0 ? (
            <div className="alert warn" style={{ marginTop: 8 }}>
              <Icon name="alert" />
              <div>{t('keys.dangerWarning', { scopes: dangerous.join(', ') })}</div>
            </div>
          ) : null}
        </fieldset>

        <div className="grid-2 tight">
          <div className="field">
            <label htmlFor="key-quota">{t('keys.quotaTokens')}</label>
            <input id="key-quota" type="number" min={1} value={form.quotaTokens} onChange={(e) => set('quotaTokens', e.target.value)} placeholder={t('keys.quotaPlaceholder')} />
            <span className="hint">{t('keys.quotaHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="key-period">{t('keys.quotaPeriod')}</label>
            <select id="key-period" value={form.quotaPeriod} onChange={(e) => set('quotaPeriod', e.target.value as QuotaPeriod)}>
              {QUOTA_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`keys.period.${p}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="key-sandbox">{t('keys.maxSandbox')}</label>
            <select id="key-sandbox" value={form.maxSandbox} onChange={(e) => set('maxSandbox', e.target.value as SandboxMode)}>
              {SANDBOXES.map((x) => (
                <option key={x} value={x}>
                  {t(`sandbox.${x}`)}
                </option>
              ))}
            </select>
            {form.maxSandbox === 'danger-full-access' ? <span className="hint danger-text">{t('settings.fullAccessWarning')}</span> : null}
          </div>
          <div className="field">
            <span className="label-text">{t('keys.approvals')}</span>
            <label className="checkbox">
              <input type="radio" name="key-approvals" checked={form.approvals === 'deny'} onChange={() => set('approvals', 'deny')} />
              {t('keys.approvalsDeny')}
            </label>
            <label className="checkbox">
              <input type="radio" name="key-approvals" checked={form.approvals === 'ask'} onChange={() => set('approvals', 'ask')} />
              {t('keys.approvalsAsk')}
            </label>
          </div>
        </div>
        <label className="checkbox" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={form.allowNetwork} onChange={(e) => set('allowNetwork', e.target.checked)} />
          {t('keys.allowNetwork')}
        </label>

        <details className="advanced">
          <summary>{t('keys.limitsTitle')}</summary>
          <div className="grid-2 tight" style={{ marginTop: 10 }}>
            {(
              [
                ['perMinute', 'keys.limit.perMinute', 10_000],
                ['promptsPerMinute', 'keys.limit.promptsPerMinute', 1_000],
                ['concurrent', 'keys.limit.concurrent', 20],
                ['uploadMbPerHour', 'keys.limit.uploadMbPerHour', 100_000],
              ] as const
            ).map(([k, label, max]) => (
              <div className="field" key={k}>
                <label htmlFor={`key-limit-${k}`}>{t(label)}</label>
                <input id={`key-limit-${k}`} type="number" min={1} max={max} value={form.limits[k]} onChange={(e) => setLimit(k, e.target.value)} required />
              </div>
            ))}
          </div>
          <div className="field">
            <label htmlFor="key-ips">{t('keys.ipAllowlist')}</label>
            <textarea id="key-ips" className="mono" rows={3} value={form.ipAllowlist} onChange={(e) => set('ipAllowlist', e.target.value)} spellCheck={false} />
            <span className="hint">{t('keys.ipAllowlistHint')}</span>
          </div>
          {!edit ? (
            <div className="field">
              <label htmlFor="key-folder">{t('keys.folder')}</label>
              <input id="key-folder" className="mono" value={form.folder} onChange={(e) => set('folder', e.target.value)} maxLength={500} spellCheck={false} />
              <span className="hint">{t('keys.folderHint')}</span>
            </div>
          ) : null}
        </details>

        <div className="alert" style={{ marginTop: 12 }}>
          <Icon name="info" />
          <div>{t('keys.readsNotSandboxed')}</div>
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !form.label.trim() || form.scopes.length === 0}>
            {edit ? t('common.save') : t('keys.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SecretDialog({ secret, onClose }: { secret: ApiKeySecret; onClose: () => void }) {
  const { t } = useI18n();
  const base = `${secret.baseUrl}/v1`;
  const auth = '-H "Authorization: Bearer $CODEX_CONSOLE_KEY"';
  const json = "-H 'Content-Type: application/json'";
  const example = [
    `export CODEX_CONSOLE_KEY='${secret.secret}'`,
    `curl -s ${base}/me ${auth}`,
    `SID=$(curl -s -X POST ${base}/sessions ${auth} ${json} -d '{"title":"test"}' | jq -r .session.id)`,
    `curl -s -X POST ${base}/sessions/$SID/turns ${auth} ${json} -d '{"text":"Hello","wait":true}'`,
  ].join('\n');
  return (
    <Modal
      title={t('keys.secretTitle', { label: secret.key.label })}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('keys.secretDone')}
        </button>
      }
    >
      <div className="alert warn">
        <Icon name="alert" />
        <div>{t('keys.secretOnce')}</div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="key-secret">{t('keys.secret')}</label>
        <div className="row">
          <input id="key-secret" className="mono" readOnly value={secret.secret} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={secret.secret} />
        </div>
      </div>
      <h3 className="section-title" style={{ marginTop: 14 }}>
        {t('keys.example')}
      </h3>
      <pre className="log">{example}</pre>
      <div className="row">
        <CopyButton text={example} />
        <span className="muted" style={{ fontSize: 13 }}>
          {t('keys.exampleHint')}
        </span>
      </div>
    </Modal>
  );
}

function RotateDialog({ k, onClose, onRotated }: { k: ApiKeyInfo; onClose: () => void; onRotated: (s: ApiKeySecret) => void }) {
  const { t } = useI18n();
  const [grace, setGrace] = useState<0 | 3600 | 86_400>(3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options = [
    [0, t('keys.graceNone')],
    [3600, t('keys.grace1h')],
    [86_400, t('keys.grace24h')],
  ] as const;
  return (
    <Modal
      title={t('keys.rotateTitle', { label: k.label })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onRotated(await post<ApiKeySecret>(`/api/admin/api-keys/${k.id}/rotate`, { graceSec: grace }));
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            {t('keys.rotate')}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{t('keys.rotateBody')}</p>
      {options.map(([v, label]) => (
        <label key={v} className="checkbox" style={{ marginBottom: 6 }}>
          <input type="radio" name="grace" checked={grace === v} onChange={() => setGrace(v)} />
          {label}
        </label>
      ))}
      <ErrorAlert error={error} />
    </Modal>
  );
}

function UsageDialog({ k, onClose, onAdminLost }: { k: ApiKeyInfo; onClose: () => void; onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const tz = new Date().getTimezoneOffset();
  const { data, error } = useAdminData<ApiKeyUsage>(`/api/admin/api-keys/${k.id}/usage?tz=${tz}`, onAdminLost);
  const u = data?.key.usage30d;
  return (
    <Modal title={t('keys.usageTitle', { label: k.label })} onClose={onClose} wide>
      <ErrorAlert error={error} />
      {!data || !u ? (
        error ? null : <Spinner />
      ) : (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="k-label">{t('keys.usage.requests')}</div>
              <div className="k-value">{fmtCompact(lang, u.requests)}</div>
            </div>
            <div className="kpi">
              <div className="k-label">{t('requests.tokens')}</div>
              <div className="k-value">{`${fmtCompact(lang, u.inputTokens)} / ${fmtCompact(lang, u.outputTokens)}`}</div>
            </div>
            <div className="kpi">
              <div className="k-label">{t('keys.usage.failed')}</div>
              <div className="k-value">{fmtCompact(lang, u.failed)}</div>
            </div>
            <div className="kpi">
              <div className="k-label">{t('keys.usage.transfer')}</div>
              <div className="k-value">{`${fmtBytes(t, u.uploadBytes)} / ${fmtBytes(t, u.downloadBytes)}`}</div>
            </div>
            <div className="kpi">
              <div className="k-label">{t('keys.usage.apiCalls')}</div>
              <div className="k-value">{fmtCompact(lang, u.apiCalls)}</div>
            </div>
          </div>
          <h3 className="section-title">{t('keys.usage.daily')}</h3>
          <DailyColumns data={data.daily} />
          <h3 className="section-title" style={{ marginTop: 16 }}>
            {t('keys.usage.recent')}
          </h3>
          {data.recent.length === 0 ? (
            <p className="muted">{t('requests.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('requests.time')}</th>
                    <th>{t('requests.session')}</th>
                    <th>{t('requests.status')}</th>
                    <th>{t('requests.duration')}</th>
                    <th>{t('requests.tokens')}</th>
                    <th>{t('requests.ip')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDateTime(lang, r.startedAt)}</td>
                      <td className="clip">
                        {r.sessionTitle !== null ? (
                          <a
                            href={`/s/${r.sessionId}`}
                            onClick={(e) => {
                              e.preventDefault();
                              navigate(`/s/${r.sessionId}`);
                            }}
                          >
                            {r.sessionTitle || r.sessionId}
                          </a>
                        ) : (
                          <span className="muted">{t('requests.deletedSession')}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${statusTone(r.status)}`}>{t(`status.${r.status}`)}</span>
                      </td>
                      <td className="num">{fmtDuration(t, r.durationMs)}</td>
                      <td className="num">{r.inputTokens !== null ? `${fmtCompact(lang, r.inputTokens)} / ${fmtCompact(lang, r.outputTokens ?? 0)}` : '—'}</td>
                      <td className="mono nowrap">{r.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function ApiKeysTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const { data, error, reload } = useAdminData<{ keys: ApiKeyInfo[]; api: { enabled: boolean; baseUrl: string } }>('/api/admin/api-keys', onAdminLost, 20_000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ApiKeyInfo | null>(null);
  const [rotating, setRotating] = useState<ApiKeyInfo | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const [usage, setUsage] = useState<ApiKeyInfo | null>(null);
  const [secret, setSecret] = useState<ApiKeySecret | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  if (!data) return error ? <ErrorAlert error={error} /> : <Spinner />;
  const keys = data.keys.filter((k) => showRevoked || k.status !== 'revoked');
  const revokedCount = data.keys.filter((k) => k.status === 'revoked').length;
  return (
    <div>
      <ApiStatus api={data.api} />
      <div className="toolbar">
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          {t('keys.new')}
        </button>
        {revokedCount > 0 ? (
          <label className="checkbox">
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
            {t('keys.showRevoked', { count: revokedCount })}
          </label>
        ) : null}
      </div>
      <ErrorAlert error={error} />
      {keys.length === 0 ? (
        <p className="empty">{t('keys.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('keys.label')}</th>
                <th>{t('devices.status')}</th>
                <th>{t('keys.quota')}</th>
                <th>{t('keys.scopes')}</th>
                <th>{t('devices.lastUsed')}</th>
                <th>{t('devices.usage30d')}</th>
                <th>
                  <span className="sr-only">{t('keys.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div>
                      <strong>{k.label}</strong>
                    </div>
                    <div className="mono muted" style={{ fontSize: 12 }}>
                      {k.display}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t('keys.expiresLine', { when: k.expiresAt ? fmtDateTime(lang, k.expiresAt) : t('devices.expiresNever') })}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${keyTone(k.status)}`}>{t(`keys.status.${k.status}`)}</span>
                    {k.graceUntil && k.graceUntil > Date.now() ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {t('keys.graceUntil', { time: fmtRelative(lang, t, k.graceUntil) })}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <QuotaMeter k={k} />
                  </td>
                  <td>
                    <div className="tag-list">
                      {k.scopes.map((s) => (
                        <span key={s} className={`badge ${DANGER.has(s) ? 'warn' : ''}`}>
                          {s}
                        </span>
                      ))}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {t(`sandbox.${k.maxSandbox}`)} · {k.allowNetwork ? t('keys.networkYes') : t('keys.networkNo')} ·{' '}
                      {k.approvals === 'deny' ? t('keys.approvalsDenyShort') : t('keys.approvalsAskShort')}
                    </div>
                  </td>
                  <td className="nowrap">
                    <div>{k.lastUsedAt ? fmtRelative(lang, t, k.lastUsedAt) : t('common.never')}</div>
                    {k.lastIp ? (
                      <div className="mono muted" style={{ fontSize: 12 }}>
                        {k.lastIp}
                      </div>
                    ) : null}
                  </td>
                  <td className="nowrap">
                    <div>{t('devices.usageLine', { requests: fmtNumber(lang, k.usage30d.requests), tokens: fmtCompact(lang, k.usage30d.inputTokens + k.usage30d.outputTokens) })}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t('devices.transferLine', { up: fmtBytes(t, k.usage30d.uploadBytes), down: fmtBytes(t, k.usage30d.downloadBytes) })}
                    </div>
                  </td>
                  <td>
                    <div className="row nowrap">
                      <button type="button" className="btn small" onClick={() => setUsage(k)}>
                        {t('keys.usage')}
                      </button>
                      {k.status !== 'revoked' ? (
                        <>
                          <button type="button" className="btn small" onClick={() => setEditing(k)}>
                            {t('keys.edit')}
                          </button>
                          <button type="button" className="btn small" onClick={() => setRotating(k)}>
                            {t('keys.rotate')}
                          </button>
                          <button type="button" className="btn small danger" onClick={() => setRevoking(k)}>
                            {t('devices.revoke')}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating || editing ? (
        <KeyFormDialog
          edit={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
            void reload();
          }}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
      {rotating ? (
        <RotateDialog
          k={rotating}
          onClose={() => setRotating(null)}
          onRotated={(s) => {
            setRotating(null);
            setSecret(s);
            void reload();
          }}
        />
      ) : null}
      {revoking ? (
        <ConfirmDialog
          title={t('keys.revokeTitle')}
          message={t('keys.revokeBody', { label: revoking.label })}
          confirmLabel={t('devices.revoke')}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await post(`/api/admin/api-keys/${revoking.id}/revoke`);
            void reload();
          }}
        />
      ) : null}
      {usage ? <UsageDialog k={usage} onClose={() => setUsage(null)} onAdminLost={onAdminLost} /> : null}
      {secret ? <SecretDialog secret={secret} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}
