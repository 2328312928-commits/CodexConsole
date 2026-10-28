import { useState } from 'react';
import { REQUEST_STATUSES, type Page, type RequestRow, type RequestStatus } from '../../../../shared/api.js';
import type { MessageKey } from '../../../../shared/i18n/index.js';
import { qs } from '../../api';
import { ErrorAlert, Spinner } from '../../components/ui';
import { fmtBytes, fmtCompact, fmtDateTime, fmtDuration, fmtNumber } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { navigate } from '../../router';
import { Pager, SourceFilter, sourceParams, useAdminData, ViaCell } from './common';

const LIMIT = 50;

export function statusTone(s: RequestStatus): string {
  if (s === 'completed') return 'good';
  if (s === 'running') return 'info';
  if (s === 'interrupted' || s === 'rate_limited' || s === 'usage_limited') return 'warn';
  return 'bad';
}

const KIND_KEYS = { prompt: 'requests.kind.prompt', review: 'turn.kind.review', compact: 'turn.kind.compact', shell: 'turn.kind.shell', auto: 'turn.kind.auto' } as const;

function kindLabel(t: (k: MessageKey) => string, kind: string): string {
  return kind in KIND_KEYS ? t(KIND_KEYS[kind as keyof typeof KIND_KEYS]) : kind;
}

export function RequestsTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const filters = { ...sourceParams(source), status: status || undefined };
  const { data, error } = useAdminData<Page<RequestRow>>(`/api/admin/requests${qs({ ...filters, limit: LIMIT, offset })}`, onAdminLost, 10_000);

  return (
    <div>
      <div className="toolbar">
        <SourceFilter id="rq-source" value={source} onChange={(v) => { setSource(v); setOffset(0); }} onAdminLost={onAdminLost} />
        <label className="sr-only" htmlFor="rq-status">
          {t('requests.status')}
        </label>
        <select id="rq-status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">{t('requests.filterStatus')}</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <a className="btn small" href={`/api/admin/requests.csv${qs(filters)}`} download>
          <Icon name="download" size={15} />
          {t('requests.exportCsv')}
        </a>
      </div>
      <ErrorAlert error={error} />
      {!data ? (
        <Spinner />
      ) : data.rows.length === 0 ? (
        <p className="empty">{t('requests.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('requests.time')}</th>
                  <th>{t('requests.session')}</th>
                  <th>{t('requests.via')}</th>
                  <th>{t('requests.kind')}</th>
                  <th>{t('requests.promptSize')}</th>
                  <th>{t('requests.duration')}</th>
                  <th>{t('requests.status')}</th>
                  <th>{t('requests.tokens')}</th>
                  <th>{t('requests.files')}</th>
                  <th>{t('requests.model')}</th>
                  <th>{t('requests.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDateTime(lang, r.startedAt)}</td>
                    <td className="clip">
                      {r.sessionTitle !== null ? (
                        <a href={`/s/${r.sessionId}`} onClick={(e) => { e.preventDefault(); navigate(`/s/${r.sessionId}`); }} title={r.sessionTitle}>
                          {r.sessionTitle || r.sessionId}
                        </a>
                      ) : (
                        <span className="muted">{t('requests.deletedSession')}</span>
                      )}
                    </td>
                    <td>
                      <ViaCell deviceName={r.deviceName} apiKeyLabel={r.apiKeyLabel} />
                    </td>
                    <td className="nowrap">{kindLabel(t, r.kind)}</td>
                    <td className="num" title={fmtBytes(t, r.promptBytes)}>
                      {t('requests.chars', { count: fmtNumber(lang, r.promptChars) })}
                    </td>
                    <td className="num">{fmtDuration(t, r.durationMs)}</td>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{t(`status.${r.status}`)}</span>
                      {r.error ? (
                        <div className="muted clip" title={r.error} style={{ fontSize: 12, marginTop: 2 }}>
                          {r.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      {r.inputTokens !== null ? `${fmtCompact(lang, r.inputTokens)} / ${fmtCompact(lang, r.outputTokens ?? 0)}` : '—'}
                    </td>
                    <td className="num" title={fmtBytes(t, r.attachmentBytes)}>
                      {r.attachmentCount} / {r.mediaCount}
                    </td>
                    <td className="nowrap mono">{r.model ?? '—'}</td>
                    <td className="nowrap mono">{r.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
