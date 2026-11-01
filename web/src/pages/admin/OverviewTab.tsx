import { useState } from 'react';
import type { AdminOverview } from '../../../../shared/api.js';
import { post } from '../../api';
import { useCodexStatus } from '../../codexStatus';
import { ErrorAlert } from '../../components/ui';
import { fmtBytes, fmtCompact, fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { DailyColumns, LimitLines, LimitMeter } from './charts';
import { useAdminData } from './common';
import { navigate } from '../../router';

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
    </div>
  );
}

export function OverviewTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const tz = new Date().getTimezoneOffset();
  const { data, error, reload, loading } = useAdminData<AdminOverview>(`/api/admin/overview?tz=${tz}`, onAdminLost, 15_000);
  const codexCtx = useCodexStatus();
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  if (!data) return <ErrorAlert error={error} />;
  const { codex, totals, publicApi } = data;
  const acct = codex.account;
  const accountText = !acct
    ? t('overview.accountNone')
    : acct.type === 'chatgpt'
      ? t('overview.accountChatgpt', { plan: acct.planType ?? t('common.unknown') })
      : acct.type === 'apiKey'
        ? t('overview.accountApiKey')
        : acct.type;
  const extraLimits = Object.entries(codex.rateLimitsByLimitId).filter(([id]) => id !== codex.rateLimits?.limitId);

  return (
    <div style={{ opacity: loading ? 0.85 : 1 }}>
      <div className="toolbar">
        <button
          type="button"
          className="btn small"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            setRefreshError(null);
            try {
              await post('/api/admin/codex/refresh');
              await Promise.all([reload(), codexCtx.refresh()]);
            } catch (err) {
              setRefreshError(err);
            } finally {
              setRefreshing(false);
            }
          }}
        >
          <Icon name="refresh" size={15} />
          {t('overview.refreshCodex')}
        </button>
        {codex.rateLimitsAt ? <span className="muted">{t('overview.updatedAt', { time: fmtRelative(lang, t, codex.rateLimitsAt) })}</span> : null}
      </div>
      <ErrorAlert error={refreshError ?? error} />

      <div className="grid-2">
        <section className="card">
          <h2 className="section-title">
            <Icon name="terminal" /> {t('overview.codex')}
          </h2>
          <dl className="facts">
            <dt>{t('codex.status')}</dt>
            <dd>
              <span className={`badge ${codex.state === 'ready' ? 'good' : 'bad'}`}>{t(`codex.state.${codex.state}`)}</span>
            </dd>
            <dt>{t('overview.version')}</dt>
            <dd>
              {codex.version ?? '—'}{' '}
              {codex.versionMismatch ? <span className="badge warn">{t('codex.versionMismatch', { version: codex.version ?? '?', tested: codex.testedVersion })}</span> : null}
            </dd>
            <dt>{t('overview.account')}</dt>
            <dd>{codex.signedIn ? accountText : <span className="badge warn">{t('overview.accountNone')}</span>}</dd>
            {acct?.email ? (
              <>
                <dt>{t('overview.email')}</dt>
                <dd>{acct.email}</dd>
              </>
            ) : null}
            <dt>{t('overview.sandbox')}</dt>
            <dd className="mono">{codex.sandbox}</dd>
            <dt>{t('overview.approvals')}</dt>
            <dd className="mono">{codex.approvalPolicy}</dd>
            <dt>{t('overview.network')}</dt>
            <dd>{codex.networkAccess ? t('codex.networkOn') : t('codex.networkOff')}</dd>
            <dt>{t('overview.restarts')}</dt>
            <dd>{codex.restarts}</dd>
            {codex.lastError ? (
              <>
                <dt>{t('overview.lastError')}</dt>
                <dd className="mono muted">{codex.lastError}</dd>
              </>
            ) : null}
          </dl>
          {!codex.signedIn && codex.state === 'ready' ? (
            <div className="alert warn" style={{ marginTop: 12 }}>
              <Icon name="key" />
              {t('codex.notSignedIn')}
            </div>
          ) : null}
        </section>

        <section className="card">
          <h2 className="section-title">
            <Icon name="history" /> {t('codex.limits')}
            {codex.rateLimits?.planType ? <span className="badge info">{t('codex.plan', { plan: codex.rateLimits.planType })}</span> : null}
          </h2>
          {codex.rateLimits && (codex.rateLimits.primary || codex.rateLimits.secondary) ? (
            <>
              {codex.rateLimits.primary ? <LimitMeter label={t('codex.limitPrimary')} window={codex.rateLimits.primary} /> : null}
              {codex.rateLimits.secondary ? <LimitMeter label={t('codex.limitSecondary')} window={codex.rateLimits.secondary} /> : null}
              {extraLimits.map(([id, snap]) => (
                <div key={id}>
                  <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                    {snap.limitName ?? id}
                  </div>
                  {snap.primary ? <LimitMeter label={t('codex.limitPrimary')} window={snap.primary} /> : null}
                  {snap.secondary ? <LimitMeter label={t('codex.limitSecondary')} window={snap.secondary} /> : null}
                </div>
              ))}
              {codex.rateLimits.credits ? (
                <p className="muted" style={{ margin: 0 }}>
                  {codex.rateLimits.credits.unlimited ? t('codex.creditsUnlimited') : t('codex.credits', { balance: codex.rateLimits.credits.balance ?? '0' })}
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">{t('codex.limitsUnavailable')}</p>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 className="section-title">
          <Icon name="globe" /> {t('keys.publicApi')}
          <span className={`badge ${publicApi.enabled ? 'good' : ''}`}>{publicApi.enabled ? t('keys.apiOn') : t('keys.apiOff')}</span>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => navigate('/admin/keys')}>
            <Icon name="key" size={15} />
            {t('overview.manageKeys')}
          </button>
        </h2>
        <dl className="facts">
          <dt>{t('overview.apiBaseUrl')}</dt>
          <dd className="mono">{publicApi.enabled ? `${publicApi.baseUrl}/v1` : '—'}</dd>
          <dt>{t('overview.apiListen')}</dt>
          <dd className="mono">{publicApi.enabled ? publicApi.listen : '—'}</dd>
          <dt>{t('overview.apiProxy')}</dt>
          <dd className="mono">{publicApi.proxyProtocol}</dd>
          <dt>{t('overview.apiKeys')}</dt>
          <dd>{publicApi.activeKeys}</dd>
          <dt>{t('overview.apiRequests')}</dt>
          <dd>{fmtCompact(lang, publicApi.requests24h)}</dd>
        </dl>
        {!publicApi.enabled ? <p className="muted" style={{ marginBottom: 0 }}>{t('keys.apiOffHint')}</p> : null}
      </section>

      <div className="kpis">
        <Kpi label={t('overview.requests24h')} value={fmtCompact(lang, totals.requests24h)} />
        <Kpi label={t('overview.requests7d')} value={fmtCompact(lang, totals.requests7d)} />
        <Kpi label={t('overview.tokens24h')} value={`${fmtCompact(lang, totals.tokens24h.input)} / ${fmtCompact(lang, totals.tokens24h.output)}`} />
        <Kpi label={t('overview.tokens7d')} value={`${fmtCompact(lang, totals.tokens7d.input)} / ${fmtCompact(lang, totals.tokens7d.output)}`} />
        <Kpi label={t('overview.failed7d')} value={fmtCompact(lang, totals.failed7d)} />
        <Kpi label={t('overview.transfer7d')} value={`${fmtBytes(t, totals.uploadBytes7d)} / ${fmtBytes(t, totals.downloadBytes7d)}`} />
        <Kpi label={t('overview.activeSignIns')} value={String(totals.activeSignIns)} />
        <Kpi label={t('overview.securityEvents')} value={String(totals.securityEvents24h)} />
      </div>

      <div className="grid-2">
        <section className="card">
          <h2 className="section-title">{t('overview.daily')}</h2>
          <DailyColumns data={data.daily} />
        </section>
        <section className="card">
          <h2 className="section-title">{t('overview.limitHistory')}</h2>
          <LimitLines points={data.limitHistory} />
        </section>
      </div>
    </div>
  );
}
