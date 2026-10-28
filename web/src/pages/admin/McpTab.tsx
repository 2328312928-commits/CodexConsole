import { useState, type FormEvent } from 'react';
import type { McpServerInput, McpServerView } from '../../../../shared/api.js';
import type { MessageKey } from '../../../../shared/i18n/index.js';
import { del, post, put } from '../../api';
import { ConfirmDialog, CopyButton, ErrorAlert, Modal, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { useAdminData } from './common';

const RUNTIME_KEYS: Record<string, MessageKey> = {
  notStarted: 'mcp.runtime.notStarted',
  starting: 'mcp.runtime.starting',
  connected: 'mcp.runtime.connected',
  authenticationRequired: 'mcp.runtime.authenticationRequired',
  failed: 'mcp.runtime.failed',
  cancelled: 'mcp.runtime.cancelled',
  disabled: 'mcp.runtime.disabled',
};
const AUTH_KEYS: Record<string, MessageKey> = {
  unknown: 'mcp.auth.unknown',
  unsupported: 'mcp.auth.unsupported',
  notLoggedIn: 'mcp.auth.notLoggedIn',
  bearerToken: 'mcp.auth.bearerToken',
  oAuth: 'mcp.auth.oAuth',
};

function runtimeTone(s: string | null): string {
  return s === 'connected' ? 'good' : s === 'failed' || s === 'authenticationRequired' ? 'bad' : s === 'disabled' || s === null ? '' : 'info';
}

interface EnvRow {
  key: string;
  value: string;
  /** Already stored on the host: a blank value keeps it. */
  existing: boolean;
}

interface McpForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  cwd: string;
  env: EnvRow[];
  url: string;
  bearerTokenEnvVar: string;
  enabled: boolean;
  enabledTools: string;
  disabledTools: string;
  startupTimeoutSec: string;
  toolTimeoutSec: string;
}

const list = (v: string) =>
  v
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function formFrom(s: McpServerView | null): McpForm {
  return {
    name: s?.name ?? '',
    transport: s?.transport ?? 'stdio',
    command: s?.command ?? '',
    args: s?.args.join('\n') ?? '',
    cwd: s?.cwd ?? '',
    env: s?.envKeys.map((key) => ({ key, value: '', existing: true })) ?? [],
    url: s?.url ?? '',
    bearerTokenEnvVar: s?.bearerTokenEnvVar ?? '',
    enabled: s?.enabled ?? true,
    enabledTools: s?.enabledTools?.join(', ') ?? '',
    disabledTools: s?.disabledTools?.join(', ') ?? '',
    startupTimeoutSec: s?.startupTimeoutSec ? String(s.startupTimeoutSec) : '',
    toolTimeoutSec: s?.toolTimeoutSec ? String(s.toolTimeoutSec) : '',
  };
}

function toInput(f: McpForm): McpServerInput {
  const base = {
    enabled: f.enabled,
    enabledTools: f.enabledTools.trim() ? list(f.enabledTools) : null,
    disabledTools: f.disabledTools.trim() ? list(f.disabledTools) : null,
    startupTimeoutSec: f.startupTimeoutSec ? Number(f.startupTimeoutSec) : null,
    toolTimeoutSec: f.toolTimeoutSec ? Number(f.toolTimeoutSec) : null,
  };
  if (f.transport === 'http') {
    return { ...base, transport: 'http', url: f.url.trim(), bearerTokenEnvVar: f.bearerTokenEnvVar.trim() || null };
  }
  const env: Record<string, string> = {};
  for (const r of f.env) if (r.key.trim()) env[r.key.trim()] = r.value;
  return {
    ...base,
    transport: 'stdio',
    command: f.command.trim(),
    args: f.args.split('\n').map((x) => x.trim()).filter(Boolean),
    cwd: f.cwd.trim() || null,
    env,
  };
}

function McpFormDialog({ edit, onClose, onSaved }: { edit: McpServerView | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<McpForm>(() => formFrom(edit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof McpForm>(k: K, v: McpForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setEnv = (i: number, patch: Partial<EnvRow>) => setForm((f) => ({ ...f, env: f.env.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const nameOk = /^[A-Za-z0-9_-]{1,64}$/.test(form.name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (edit) await put(`/api/admin/mcp/${edit.name}`, toInput(form));
      else await post('/api/admin/mcp', { name: form.name, ...toInput(form) });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={edit ? t('mcp.editTitle', { name: edit.name }) : t('mcp.addTitle')} onClose={onClose} wide>
      <form onSubmit={submit}>
        {!edit ? (
          <div className="field">
            <label htmlFor="mcp-name">{t('mcp.name')}</label>
            <input id="mcp-name" className="mono" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={64} required spellCheck={false} aria-invalid={form.name !== '' && !nameOk} />
            <span className={`hint ${form.name !== '' && !nameOk ? 'danger-text' : ''}`}>{t('error.invalid_name')}</span>
          </div>
        ) : null}
        <fieldset className="field">
          <legend>{t('mcp.transport')}</legend>
          <label className="checkbox">
            <input type="radio" name="mcp-transport" checked={form.transport === 'stdio'} onChange={() => set('transport', 'stdio')} />
            {t('mcp.transport.stdio')}
          </label>
          <label className="checkbox">
            <input type="radio" name="mcp-transport" checked={form.transport === 'http'} onChange={() => set('transport', 'http')} />
            {t('mcp.transport.http')}
          </label>
        </fieldset>
        {form.transport === 'stdio' ? (
          <>
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <Icon name="alert" />
              <div>{t('mcp.stdioWarning')}</div>
            </div>
            <div className="field">
              <label htmlFor="mcp-command">{t('mcp.command')}</label>
              <input id="mcp-command" className="mono" value={form.command} onChange={(e) => set('command', e.target.value)} required spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="mcp-args">{t('mcp.args')}</label>
              <textarea id="mcp-args" className="mono" rows={3} value={form.args} onChange={(e) => set('args', e.target.value)} spellCheck={false} />
              <span className="hint">{t('mcp.argsHint')}</span>
            </div>
            <div className="field">
              <label htmlFor="mcp-cwd">{t('mcp.cwd')}</label>
              <input id="mcp-cwd" className="mono" value={form.cwd} onChange={(e) => set('cwd', e.target.value)} spellCheck={false} />
            </div>
            <fieldset className="field">
              <legend>{t('mcp.env')}</legend>
              <span className="hint" style={{ marginBottom: 6 }}>
                {t('mcp.envHint')}
              </span>
              {form.env.map((r, i) => (
                <div className="row env-row" key={i}>
                  <input className="mono" aria-label={t('mcp.envName')} value={r.key} readOnly={r.existing} onChange={(e) => setEnv(i, { key: e.target.value })} spellCheck={false} />
                  <input
                    className="mono"
                    type="password"
                    autoComplete="new-password"
                    aria-label={t('mcp.envValue', { name: r.key || '…' })}
                    placeholder={r.existing ? t('mcp.envKeep') : ''}
                    value={r.value}
                    onChange={(e) => setEnv(i, { value: e.target.value })}
                  />
                  <button type="button" className="btn ghost icon small" onClick={() => set('env', form.env.filter((_, j) => j !== i))} aria-label={t('mcp.envRemove', { name: r.key || '…' })}>
                    <Icon name="x" size={15} />
                  </button>
                </div>
              ))}
              <button type="button" className="btn small" onClick={() => set('env', [...form.env, { key: '', value: '', existing: false }])}>
                <Icon name="plus" size={14} />
                {t('mcp.envAdd')}
              </button>
            </fieldset>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="mcp-url">{t('mcp.url')}</label>
              <input id="mcp-url" className="mono" type="url" value={form.url} onChange={(e) => set('url', e.target.value)} required spellCheck={false} />
              <span className="hint">{t('mcp.urlHint')}</span>
            </div>
            <div className="field">
              <label htmlFor="mcp-bearer">{t('mcp.bearer')}</label>
              <input id="mcp-bearer" className="mono" value={form.bearerTokenEnvVar} onChange={(e) => set('bearerTokenEnvVar', e.target.value)} spellCheck={false} />
              <span className="hint">{t('mcp.bearerHint')}</span>
            </div>
          </>
        )}
        <details className="advanced">
          <summary>{t('mcp.advanced')}</summary>
          <div className="grid-2 tight" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="mcp-startup">{t('mcp.startupTimeout')}</label>
              <input id="mcp-startup" type="number" min={1} max={600} value={form.startupTimeoutSec} onChange={(e) => set('startupTimeoutSec', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="mcp-tooltimeout">{t('mcp.toolTimeout')}</label>
              <input id="mcp-tooltimeout" type="number" min={1} max={3600} value={form.toolTimeoutSec} onChange={(e) => set('toolTimeoutSec', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="mcp-enabled-tools">{t('mcp.enabledTools')}</label>
            <input id="mcp-enabled-tools" className="mono" value={form.enabledTools} onChange={(e) => set('enabledTools', e.target.value)} spellCheck={false} />
            <span className="hint">{t('mcp.enabledToolsHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="mcp-disabled-tools">{t('mcp.disabledTools')}</label>
            <input id="mcp-disabled-tools" className="mono" value={form.disabledTools} onChange={(e) => set('disabledTools', e.target.value)} spellCheck={false} />
          </div>
        </details>
        <label className="checkbox" style={{ margin: '12px 0' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          {t('mcp.enabled')}
        </label>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || (!edit && !nameOk)}>
            {edit ? t('common.save') : t('mcp.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LoginDialog({ server, url, onClose }: { server: string; url: string; onClose: () => void }) {
  const { t } = useI18n();
  const safe = /^https?:\/\//i.test(url) ? url : null;
  return (
    <Modal
      title={t('mcp.loginTitle', { name: server })}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <p style={{ marginTop: 0 }}>{t('mcp.loginBody')}</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <code className="url-box">{url}</code>
        <CopyButton text={url} />
        {safe ? (
          <a className="btn small" href={safe} target="_blank" rel="noopener noreferrer">
            <Icon name="link" size={15} />
            {t('question.openLink')}
          </a>
        ) : null}
      </div>
      <p className="muted">{t('mcp.loginHostHint')}</p>
    </Modal>
  );
}

function ServerCard({ s, onEdit, onChanged, onRemove }: { s: McpServerView; onEdit: () => void; onChanged: () => void; onRemove: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [login, setLogin] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const runtime = s.runtimeStatus;
  const auth = s.authStatus;
  const canLogin = s.transport === 'http' && (auth === 'notLoggedIn' || auth === 'oAuth' || runtime === 'authenticationRequired');
  return (
    <section className="card mcp-card">
      <div className="mcp-head">
        <h3 className="mono">{s.name}</h3>
        <span className="badge">{s.transport === 'stdio' ? t('mcp.transport.stdioShort') : t('mcp.transport.httpShort')}</span>
        <span className={`badge ${runtimeTone(runtime)}`}>{runtime ? (RUNTIME_KEYS[runtime] ? t(RUNTIME_KEYS[runtime]!) : runtime) : t('mcp.runtime.unknown')}</span>
        {auth && auth !== 'unsupported' ? <span className={`badge ${auth === 'notLoggedIn' ? 'warn' : ''}`}>{AUTH_KEYS[auth] ? t(AUTH_KEYS[auth]!) : auth}</span> : null}
        <span className="spacer" />
        <label className="checkbox">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void run(() => post(`/api/admin/mcp/${s.name}/enabled`, { enabled: e.target.checked }))} />
          {t('mcp.enabled')}
        </label>
      </div>
      <div className="mono muted mcp-target" title={s.url ?? [s.command, ...s.args].join(' ')}>
        {s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')}
      </div>
      {s.envKeys.length > 0 ? (
        <div className="tag-list" style={{ marginTop: 6 }}>
          {s.envKeys.map((k) => (
            <span key={k} className="badge mono">
              {k}=••••
            </span>
          ))}
        </div>
      ) : null}
      {s.error ? (
        <div className="alert error" style={{ marginTop: 8 }}>
          <Icon name="alert" />
          <div className="mono">{s.error}</div>
        </div>
      ) : null}
      {s.tools.length > 0 ? (
        <details className="mcp-tools">
          <summary>{t('mcp.tools', { count: s.tools.length })}{s.resourceCount ? ` · ${t('mcp.resources', { count: s.resourceCount })}` : ''}</summary>
          <ul>
            {s.tools.map((tool) => (
              <li key={tool.name}>
                <span className="mono">{tool.name}</span>
                {tool.description ? <span className="muted"> — {tool.description}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          {s.enabled ? t('mcp.noTools') : t('mcp.disabledNote')}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="btn small" onClick={onEdit} disabled={busy}>
          <Icon name="edit" size={14} />
          {t('keys.edit')}
        </button>
        {canLogin ? (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await post<{ authorizationUrl: string }>(`/api/admin/mcp/${s.name}/login`);
                setLogin(r.authorizationUrl);
              })
            }
          >
            <Icon name="key" size={14} />
            {t('mcp.login')}
          </button>
        ) : null}
        {auth === 'oAuth' ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => post(`/api/admin/mcp/${s.name}/logout`))}>
            <Icon name="logout" size={14} />
            {t('mcp.logout')}
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" className="btn small danger" onClick={onRemove} disabled={busy}>
          <Icon name="trash" size={14} />
          {t('mcp.remove')}
        </button>
      </div>
      <ErrorAlert error={error} />
      {login ? <LoginDialog server={s.name} url={login} onClose={() => setLogin(null)} /> : null}
    </section>
  );
}

export function McpTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t } = useI18n();
  const { data, error, reload, loading } = useAdminData<{ servers: McpServerView[] }>('/api/admin/mcp', onAdminLost, 30_000);
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  const [removing, setRemoving] = useState<McpServerView | null>(null);
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('mcp.intro')}
      </p>
      <div className="toolbar">
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} />
          {t('mcp.addTitle')}
        </button>
        <button type="button" className="btn small" onClick={() => void reload()} disabled={loading}>
          <Icon name="refresh" size={15} />
          {t('common.refresh')}
        </button>
      </div>
      <ErrorAlert error={error} />
      {!data ? (
        error ? null : <Spinner />
      ) : data.servers.length === 0 ? (
        <p className="empty">{t('mcp.empty')}</p>
      ) : (
        <div className="mcp-list">
          {data.servers.map((s) => (
            <ServerCard key={s.name} s={s} onEdit={() => setEditing(s)} onChanged={() => void reload()} onRemove={() => setRemoving(s)} />
          ))}
        </div>
      )}
      {editing ? (
        <McpFormDialog
          edit={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={t('mcp.removeTitle')}
          message={t('mcp.removeBody', { name: removing.name })}
          confirmLabel={t('mcp.remove')}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/admin/mcp/${removing.name}`);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
