import type { Lang, MessageKey, Vars } from '../../shared/i18n/index.js';
import { ApiFailure } from './api.js';

type T = (key: MessageKey, vars?: Vars) => string;

export function fmtNumber(lang: Lang, n: number): string {
  return new Intl.NumberFormat(lang).format(n);
}

export function fmtCompact(lang: Lang, n: number): string {
  return new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fmtBytes(t: T, bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return t('unit.bytes', { n: bytes });
  const units: MessageKey[] = ['unit.kb', 'unit.mb', 'unit.gb'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return t(units[i]!, { n: v >= 100 ? Math.round(v) : Number(v.toFixed(1)) });
}

export function fmtDuration(t: T, ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return t('unit.ms', { n: Math.round(ms) });
  if (ms < 60_000) return t('unit.s', { n: Number((ms / 1000).toFixed(1)) });
  if (ms < 3_600_000) return t('unit.min', { n: Number((ms / 60_000).toFixed(1)) });
  if (ms < 86_400_000) return t('unit.h', { n: Number((ms / 3_600_000).toFixed(1)) });
  return t('unit.d', { n: Number((ms / 86_400_000).toFixed(1)) });
}

export function fmtWindow(t: T, mins: number | null): string {
  if (!mins) return '—';
  if (mins % 1440 === 0) return t('unit.d', { n: mins / 1440 });
  if (mins % 60 === 0) return t('unit.h', { n: mins / 60 });
  return t('unit.min', { n: mins });
}

export function fmtDateTime(lang: Lang, ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

export function fmtTime(lang: Lang, ms: number): string {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

export function fmtRelative(lang: Lang, t: T, ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return t('common.justNow');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return fmtDateTime(lang, ms);
}

/** Human message for any thrown error. */
export function errorText(t: T, err: unknown): string {
  if (err instanceof ApiFailure) {
    if (err.code === 'network') return t('error.network');
    const key = `error.${err.code}` as MessageKey;
    return t(key);
  }
  return t('error.internal');
}

export function errorDetail(err: unknown): string | undefined {
  return err instanceof ApiFailure ? err.detail : undefined;
}
