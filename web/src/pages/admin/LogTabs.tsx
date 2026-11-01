import { useState } from 'react';
import { SECURITY_ALERT_KINDS, SECURITY_EVENT_KINDS, type FileTransferRow, type Page, type SecurityEventRow } from '../../../../shared/api.js';
import { qs } from '../../api';
import { ErrorAlert, Spinner } from '../../components/ui';
import { fmtBytes, fmtDateTime } from '../../format';
import { useI18n } from '../../i18n';
import { Pager, SourceFilter, sourceParams, useAdminData, ViaCell } from './common';

const LIMIT = 50;

export function TransfersTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const [offset, setOffset] = useState(0);
  const [direction, setDirection] = useState('');
  const [source, setSource] = useState('');
  const { data, error } = useAdminData<Page<FileTransferRow>>(
    `/api/admin/transfers${qs({ direction: direction || undefined, ...sourceParams(source), limit: LIMIT, offset })}`,
    onAdminLost,
    15_000,
  );
  const dirLabel = { upload: t('transfers.upload'), download: t('transfers.download'), view: t('transfers.view') } as const;
  return (
    <div>
      <div className="toolbar">
        <label className="sr-only" htmlFor="tr-dir">
          {t('transfers.direction')}
        </label>
        <select id="tr-dir" value={direction} onChange={(e) => { setDirection(e.target.value); setOffset(0); }}>
          <option value="">{t('transfers.filterDirection')}</option>
          {(['upload', 'download', 'view'] as const).map((d) => (
            <option key={d} value={d}>
              {dirLabel[d]}
            </option>
          ))}
        </select>
        <SourceFilter id="tr-source" value={source} onChange={(v) => { setSource(v); setOffset(0); }} onAdminLost={onAdminLost} />
      </div>
      <ErrorAlert error={error} />
      {!data ? (
        <Spinner />
      ) : data.rows.length === 0 ? (
        <p className="empty">{t('transfers.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('requests.time')}</th>
                  <th>{t('requests.via')}</th>
                  <th>{t('transfers.direction')}</th>
                  <th>{t('transfers.path')}</th>
                  <th>{t('files.size')}</th>
                  <th>{t('requests.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDateTime(lang, r.at)}</td>
                    <td>
                      <ViaCell deviceName={r.deviceName} apiKeyLabel={r.apiKeyLabel} />
                    </td>
                    <td>{dirLabel[r.direction]}</td>
                    <td className="mono clip" title={r.path}>
                      {r.path}
                    </td>
                    <td className="num">{fmtBytes(t, r.bytes)}</td>
                    <td>
                      <span className={`badge ${r.ok ? 'good' : 'bad'}`}>{r.ok ? t('transfers.ok') : t('transfers.failed')}</span>
                    </td>
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

const ALERT_KINDS = new Set<string>(SECURITY_ALERT_KINDS);

export function SecurityTab({ onAdminLost }: { onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const { data, error } = useAdminData<Page<SecurityEventRow>>(
    `/api/admin/security${qs({ kind: kind || undefined, key: sourceParams(source).key, limit: LIMIT, offset })}`,
    onAdminLost,
    15_000,
  );
  return (
    <div>
      <div className="toolbar">
        <label className="sr-only" htmlFor="sec-kind">
          {t('security.kind')}
        </label>
        <select id="sec-kind" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
          <option value="">{t('security.filterKind')}</option>
          {SECURITY_EVENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`security.${k}`)}
            </option>
          ))}
        </select>
        <SourceFilter id="sec-source" value={source} onChange={(v) => { setSource(v); setOffset(0); }} onAdminLost={onAdminLost} />
      </div>
      <ErrorAlert error={error} />
      {!data ? (
        <Spinner />
      ) : data.rows.length === 0 ? (
        <p className="empty">{t('security.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('requests.time')}</th>
                  <th>{t('security.kind')}</th>
                  <th>{t('requests.via')}</th>
                  <th>{t('requests.ip')}</th>
                  <th>{t('security.userAgent')}</th>
                  <th>{t('security.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDateTime(lang, r.at)}</td>
                    <td className="nowrap">
                      <span className={`badge ${ALERT_KINDS.has(r.kind) ? 'bad' : ''}`}>{t(`security.${r.kind}`)}</span>
                    </td>
                    <td>
                      <ViaCell deviceName={r.deviceName} apiKeyLabel={r.apiKeyLabel} />
                    </td>
                    <td className="mono nowrap">{r.ip ?? '—'}</td>
                    <td className="clip" title={r.userAgent ?? undefined}>
                      {r.userAgent ?? '—'}
                    </td>
                    <td className="mono clip" title={r.detail ?? undefined}>
                      {r.detail ?? ''}
                    </td>
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
