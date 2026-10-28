import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiKeyInfo, DeviceInfo } from '../../../../shared/api.js';
import { ApiFailure, get } from '../../api';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';

/**
 * Fetch an admin endpoint; refetches when the URL changes or on an interval while
 * visible. Keeps the previous data during reloads (no flash). Reports a lost
 * admin step-up so the page can show the unlock form.
 */
export function useAdminData<T>(url: string, onAdminLost: () => void, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const lost = useRef(onAdminLost);
  lost.current = onAdminLost;

  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await get<T>(url));
      setError(null);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'admin_required') lost.current();
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  return (
    <div className="pager">
      <span className="muted">{t('common.total', { count: total })}</span>
      <span>{t('common.pageOf', { page, pages })}</span>
      <button type="button" className="btn small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        {t('common.previous')}
      </button>
      <button type="button" className="btn small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        {t('common.next')}
      </button>
    </div>
  );
}

/** "d:<id>" / "k:<id>" → the query parameters the admin log endpoints take. */
export function sourceParams(source: string): { device?: string; key?: string } {
  if (source.startsWith('d:')) return { device: source.slice(2) };
  if (source.startsWith('k:')) return { key: source.slice(2) };
  return {};
}

/** One filter for "which device or API key did this". */
export function SourceFilter({ id, value, onChange, onAdminLost, devices = true }: { id: string; value: string; onChange: (v: string) => void; onAdminLost: () => void; devices?: boolean }) {
  const { t } = useI18n();
  const devs = useAdminData<{ devices: DeviceInfo[] }>(devices ? '/api/admin/devices' : '', onAdminLost);
  const keys = useAdminData<{ keys: ApiKeyInfo[] }>('/api/admin/api-keys', onAdminLost);
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {t('requests.via')}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('requests.filterSource')}</option>
        {devices && devs.data?.devices.length ? (
          <optgroup label={t('adminTab.devices')}>
            {devs.data.devices.map((d) => (
              <option key={d.id} value={`d:${d.id}`}>
                {d.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {keys.data?.keys.length ? (
          <optgroup label={t('adminTab.keys')}>
            {keys.data.keys.map((k) => (
              <option key={k.id} value={`k:${k.id}`}>
                {k.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </>
  );
}

/** Who made a request: a paired device or an API key. */
export function ViaCell({ deviceName, apiKeyLabel }: { deviceName: string | null; apiKeyLabel: string | null }) {
  if (apiKeyLabel) {
    return (
      <span className="nowrap">
        <Icon name="key" size={13} /> {apiKeyLabel}
      </span>
    );
  }
  return <span className="nowrap">{deviceName ?? '—'}</span>;
}
