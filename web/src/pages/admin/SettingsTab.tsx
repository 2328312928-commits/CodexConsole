import { useEffect, useState, type FormEvent } from 'react';
import type { AdminSettings, AuthState, CodexDefaults, CodexStatusInfo, ModelInfo } from '../../../../shared/api.js';
import type { AskForApproval, SandboxMode } from '../../../../shared/codex.js';
import { get, post, put } from '../../api';
import { ErrorAlert, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { useAdminData } from './common';

const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS: AskForApproval[] = ['untrusted', 'on-request', 'never'];

/** Codex's own defaults (config.toml on the host): used when a session doesn't pick a model. */
function CodexDefaultsCard({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const current = useAdminData<CodexDefaults>('/api/admin/codex-defaults', onAdminLost);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [form, setForm] = useState<CodexDefaults | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<{ models: ModelInfo[] }>('/api/codex/models')
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);
  useEffect(() => {
    if (current.data && !form) setForm(current.data);
  }, [current.data, form]);
  const model = models.find((m) => m.id === form?.model) ?? models.find((m) => m.isDefault);
  return (
    <section className="card">
      <h2 className="section-title">
        <Icon name="sliders" /> {t('settings.codexDefaults')}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('settings.codexDefaultsHint')}
      </p>
      <ErrorAlert error={current.error} />
      {!form ? (
        current.error ? null : <Spinner />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              setForm(await put<CodexDefaults>('/api/admin/codex-defaults', form));
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            } catch (err) {
              setError(err);
            }
          }}
        >
          <div className="field">
            <label htmlFor="cd-model">{t('session.model')}</label>
            <select id="cd-model" value={form.model ?? ''} onChange={(e) => setForm({ ...form, model: e.target.value || null, effort: null })}>
              <option value="">{t('settings.codexChooses')}</option>
              {form.model && !models.some((m) => m.id === form.model) ? <option value={form.model}>{form.model}</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cd-effort">{t('session.effort')}</label>
            <select id="cd-effort" value={form.effort ?? ''} onChange={(e) => setForm({ ...form, effort: e.target.value || null })}>
              <option value="">{t('settings.codexChooses')}</option>
              {(model?.efforts ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <ErrorAlert error={error} />
          <div className="row">
            <button type="submit" className="btn primary">
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
    </section>
  );
}

export function SettingsTab({ onAdminLost, onAuth }: { onAdminLost: () => void; onAuth: (s: AuthState) => void }) {
  const { t } = useI18n();
  const settings = useAdminData<AdminSettings>('/api/admin/settings', onAdminLost);
  const codex = useAdminData<{ status: CodexStatusInfo; bin: string; stderr: string[]; runningTurns: number }>('/api/admin/codex', onAdminLost, 15_000);
  const [form, setForm] = useState<AdminSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      setForm(await put<AdminSettings>('/api/admin/settings', form));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="grid-2">
      <section className="card">
        <h2 className="section-title">
          <Icon name="edit" /> {t('adminTab.settings')}
        </h2>
        {!form ? (
          <Spinner />
        ) : (
          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="set-retention">{t('settings.retention')}</label>
              <input
                id="set-retention"
                type="number"
                min={1}
                max={3650}
                value={form.logRetentionDays}
                onChange={(e) => setForm({ ...form, logRetentionDays: Number(e.target.value) })}
              />
              <span className="hint">{t('settings.retentionHint')}</span>
            </div>
            <div className="field">
              <label htmlFor="set-approval">{t('settings.approvalTimeout')}</label>
              <input
                id="set-approval"
                type="number"
                min={10}
                max={86400}
                value={form.approvalTimeoutSec}
                onChange={(e) => setForm({ ...form, approvalTimeoutSec: Number(e.target.value) })}
              />
              <span className="hint">{t('settings.approvalTimeoutHint')}</span>
            </div>
            <h3 className="section-title" style={{ marginTop: 16 }}>
              {t('settings.sessionDefaults')}
            </h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              {t('settings.sessionDefaultsHint')}
            </p>
            <div className="field">
              <label htmlFor="set-sandbox">{t('settings.sandbox')}</label>
              <select id="set-sandbox" value={form.defaultSandbox} onChange={(e) => setForm({ ...form, defaultSandbox: e.target.value as SandboxMode })}>
                {SANDBOXES.map((x) => (
                  <option key={x} value={x}>
                    {t(`sandbox.${x}`)}
                  </option>
                ))}
              </select>
              {form.defaultSandbox === 'danger-full-access' ? <span className="hint danger-text">{t('settings.fullAccessWarning')}</span> : null}
            </div>
            <div className="field">
              <label htmlFor="set-approvals">{t('settings.approvalPolicy')}</label>
              <select id="set-approvals" value={form.defaultApprovalPolicy} onChange={(e) => setForm({ ...form, defaultApprovalPolicy: e.target.value as AskForApproval })}>
                {APPROVALS.map((x) => (
                  <option key={x} value={x}>
                    {t(`approvalPolicy.${x}`)}
                  </option>
                ))}
              </select>
            </div>
            <label className="checkbox" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={form.defaultNetworkAccess} onChange={(e) => setForm({ ...form, defaultNetworkAccess: e.target.checked })} />
              {t('settings.networkDefault')}
            </label>
            <ErrorAlert error={error} />
            <div className="row">
              <button type="submit" className="btn primary">
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
        <h2 className="section-title" style={{ marginTop: 20 }}>
          <Icon name="shield" /> {t('settings.security')}
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('settings.securityHint')}
        </p>
        <p className="muted">{t('settings.cliHint')}</p>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              onAuth(await post<AuthState>('/api/auth/admin/lock'));
            } catch (err) {
              setError(err);
            }
          }}
        >
          <Icon name="lock" size={15} />
          {t('admin.lock')}
        </button>
      </section>

      <section className="card">
        <h2 className="section-title">
          <Icon name="terminal" /> {t('settings.codex')}
        </h2>
        {!codex.data ? (
          <Spinner />
        ) : (
          <>
            <dl className="facts">
              <dt>{t('settings.codexBin')}</dt>
              <dd className="mono">{codex.data.bin}</dd>
              <dt>{t('overview.version')}</dt>
              <dd>{codex.data.status.version ?? '—'}</dd>
              <dt>{t('codex.status')}</dt>
              <dd>{t(`codex.state.${codex.data.status.state}`)}</dd>
            </dl>
            <h3 className="section-title" style={{ marginTop: 14 }}>
              {t('settings.codexLog')}
            </h3>
            {codex.data.stderr.length === 0 ? <p className="muted">{t('settings.codexLogEmpty')}</p> : <pre className="log">{codex.data.stderr.join('\n')}</pre>}
          </>
        )}
      </section>
      <CodexDefaultsCard onAdminLost={onAdminLost} />
    </div>
  );
}
