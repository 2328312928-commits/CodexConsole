import { useState, type FormEvent } from 'react';
import type { DeviceInfo, LoginSessionInfo, PairingInfo } from '../../../../shared/api.js';
import { patch, post } from '../../api';
import { ConfirmDialog, CopyButton, ErrorAlert, Modal, Spinner } from '../../components/ui';
import { fmtBytes, fmtCompact, fmtDateTime, fmtRelative } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';
import { useAdminData } from './common';

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function PairingDialog({ info, onClose }: { info: PairingInfo; onClose: () => void }) {
  const { t, lang } = useI18n();
  return (
    <Modal title={t('devices.pairTitle', { name: info.device.name })} onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>{t('common.close')}</button>}>
      <p style={{ marginTop: 0 }}>{t('devices.pairBody', { time: fmtRelative(lang, t, info.expiresAt) })}</p>
      <img className="qr" src={svgDataUrl(info.qrSvg)} alt={t('devices.pairUrl')} />
      <div className="pair-code" aria-label={t('pair.code')}>
        {info.code}
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="pair-url">{t('devices.pairUrl')}</label>
        <div className="row">
          <input id="pair-url" className="mono" readOnly value={info.pairUrl} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={info.pairUrl} />
        </div>
      </div>
    </Modal>
  );
}

function deviceTone(s: DeviceInfo['status']): string {
  return s === 'active' ? 'good' : s === 'pending' ? 'info' : s === 'expired' ? 'warn' : 'bad';
}

export function DevicesTab({ currentDeviceId, onAdminLost }: { currentDeviceId: string | null; onAdminLost: () => void }) {
  const { t, lang } = useI18n();
  const devices = useAdminData<{ devices: DeviceInfo[] }>('/api/admin/devices', onAdminLost, 20_000);
  const logins = useAdminData<{ logins: LoginSessionInfo[] }>('/api/admin/logins', onAdminLost, 20_000);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null);
  const [renaming, setRenaming] = useState<DeviceInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const info = await post<PairingInfo>('/api/admin/devices', { name: name.trim(), expiresInDays: expiry ? Number(expiry) : null });
      setPairing(info);
      setName('');
      void devices.reload();
    } catch (err) {
      setError(err);
    }
  };

  const newCode = async (d: DeviceInfo) => {
    setError(null);
    try {
      setPairing(await post<PairingInfo>(`/api/admin/devices/${d.id}/pairing`));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2 className="section-title">
          <Icon name="plus" /> {t('devices.add')}
        </h2>
        <form className="row" onSubmit={create}>
          <label className="sr-only" htmlFor="dev-name">
            {t('devices.name')}
          </label>
          <input id="dev-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('devices.namePlaceholder')} maxLength={60} required style={{ flex: '1 1 200px' }} />
          <label className="sr-only" htmlFor="dev-expiry">
            {t('devices.expires')}
          </label>
          <select id="dev-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} title={t('devices.expires')}>
            <option value="">{t('devices.expiresOption', { when: t('devices.expiresNever') })}</option>
            {[30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {t('devices.expiresOption', { when: t('devices.expiresDays', { days: d }) })}
              </option>
            ))}
          </select>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            <Icon name="key" size={15} />
            {t('devices.create')}
          </button>
        </form>
      </section>

      <ErrorAlert error={error ?? devices.error} />
      {notice ? (
        <div className="alert" role="status" style={{ marginBottom: 12 }}>
          <Icon name="check" />
          {notice}
        </div>
      ) : null}

      <h2 className="section-title">
        <Icon name="devices" /> {t('adminTab.devices')}
      </h2>
      {!devices.data ? (
        <Spinner />
      ) : (
        <div className="table-wrap" style={{ marginBottom: 20 }}>
          <table className="data">
            <thead>
              <tr>
                <th>{t('devices.name')}</th>
                <th>{t('devices.status')}</th>
                <th>{t('devices.created')}</th>
                <th>{t('devices.lastUsed')}</th>
                <th>{t('devices.usage30d')}</th>
                <th>{t('devices.token')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.data.devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.name}</strong> {d.id === currentDeviceId ? <span className="badge info">{t('devices.thisDevice')}</span> : null}
                    {d.expiresAt ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {t('devices.expiresOption', { when: fmtDateTime(lang, d.expiresAt) })}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${deviceTone(d.status)}`}>{t(`devices.status.${d.status}`)}</span>
                  </td>
                  <td className="nowrap">{fmtDateTime(lang, d.createdAt)}</td>
                  <td>
                    <div className="nowrap">{d.lastUsedAt ? fmtRelative(lang, t, d.lastUsedAt) : t('common.never')}</div>
                    {d.lastIp ? <div className="muted mono" style={{ fontSize: 12 }}>{d.lastIp}</div> : null}
                    {d.lastUserAgent ? (
                      <div className="muted clip" style={{ fontSize: 12 }} title={d.lastUserAgent}>
                        {d.lastUserAgent}
                      </div>
                    ) : null}
                  </td>
                  <td className="nowrap">
                    <div>{t('devices.usageLine', { requests: d.usage.requests, tokens: fmtCompact(lang, d.usage.inputTokens + d.usage.outputTokens) })}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t('devices.transferLine', { up: fmtBytes(t, d.usage.uploadBytes), down: fmtBytes(t, d.usage.downloadBytes) })}
                    </div>
                  </td>
                  <td className="mono nowrap">{d.tokenHint ? `${d.tokenHint}…` : '—'}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button type="button" className="btn small ghost" onClick={() => setRenaming(d)} disabled={d.status === 'revoked'}>
                        {t('common.rename')}
                      </button>
                      {d.status !== 'revoked' ? (
                        <button type="button" className="btn small ghost" onClick={() => void newCode(d)}>
                          {t('devices.newCode')}
                        </button>
                      ) : null}
                      {d.status !== 'revoked' ? (
                        <button type="button" className="btn small danger" onClick={() => setRevoking(d)}>
                          {t('devices.revoke')}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginBottom: 10 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          <Icon name="key" /> {t('devices.logins')}
        </h2>
        <span className="spacer" />
        <button
          type="button"
          className="btn small"
          onClick={async () => {
            try {
              const res = await post<{ revoked: number }>('/api/admin/logins/revoke-others');
              setNotice(t('devices.loginsEnded', { count: res.revoked }));
              void logins.reload();
            } catch (err) {
              setError(err);
            }
          }}
        >
          {t('devices.loginEndOthers')}
        </button>
      </div>
      {!logins.data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('requests.device')}</th>
                <th>{t('devices.created')}</th>
                <th>{t('devices.loginLastSeen')}</th>
                <th>{t('requests.ip')}</th>
                <th>{t('security.userAgent')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {logins.data.logins.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.deviceName ?? l.deviceId} {l.current ? <span className="badge info">{t('devices.loginCurrent')}</span> : null}{' '}
                    {l.admin ? <span className="badge warn">{t('devices.loginAdmin')}</span> : null}
                  </td>
                  <td className="nowrap">{fmtDateTime(lang, l.createdAt)}</td>
                  <td className="nowrap">{fmtRelative(lang, t, l.lastSeenAt)}</td>
                  <td className="mono">{l.ip ?? '—'}</td>
                  <td className="clip" title={l.userAgent ?? undefined}>
                    {l.userAgent ?? '—'}
                  </td>
                  <td>
                    {!l.current ? (
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={async () => {
                          try {
                            await post(`/api/admin/logins/${l.id}/revoke`);
                            void logins.reload();
                          } catch (err) {
                            setError(err);
                          }
                        }}
                      >
                        {t('devices.loginEnd')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pairing ? <PairingDialog info={pairing} onClose={() => { setPairing(null); void devices.reload(); }} /> : null}
      {revoking ? (
        <ConfirmDialog
          title={t('devices.revoke')}
          message={t('devices.revokeConfirm', { name: revoking.name })}
          confirmLabel={t('devices.revoke')}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await post(`/api/admin/devices/${revoking.id}/revoke`);
            void devices.reload();
            void logins.reload();
          }}
        >
          {revoking.id === currentDeviceId ? (
            <div className="alert warn">
              <Icon name="alert" />
              {t('devices.revokeSelf')}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
      {renaming ? <RenameDeviceDialog device={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); void devices.reload(); }} /> : null}
    </div>
  );
}

function RenameDeviceDialog({ device, onClose, onDone }: { device: DeviceInfo; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(device.name);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await patch(`/api/admin/devices/${device.id}`, { name: name.trim() });
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t('common.rename')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="rd-name">{t('devices.renamePrompt')}</label>
          <input id="rd-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
        </div>
        <ErrorAlert error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
