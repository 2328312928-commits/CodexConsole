import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Lang } from '../../../shared/i18n/index.js';
import { errorDetail, errorText } from '../format';
import { useI18n } from '../i18n';
import { Icon } from '../icons';

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="working" role="status">
      <span className="spinner" />
      {label}
    </span>
  );
}

/** A small ⓘ whose explanation shows on hover, so forms stay free of hint text. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" title={text} aria-label={text} role="img">
      <Icon name="info" size={13} />
    </span>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const detail = errorDetail(error);
  return (
    <div className="alert error" role="alert">
      <Icon name="alert" />
      <div>
        {errorText(t, error)}
        {detail ? <div className="mono muted">{detail}</div> : null}
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // showModal() focuses the first focusable element (the close button); prefer the first field.
    d?.querySelector<HTMLElement>('.dialog-body input:not([type=hidden]):not([readonly]), .dialog-body select, .dialog-body textarea')?.focus();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'wide' : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="btn ghost icon small" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="x" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </dialog>
  );
}

/** A confirm dialog that resolves the action itself, showing errors inline. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'danger solid' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{message}</p>
      {children}
      <ErrorAlert error={error} />
    </Modal>
  );
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  const next: Lang = lang === 'en' ? 'zh-CN' : 'en';
  return (
    <button type="button" className="btn ghost small" onClick={() => setLang(next)} aria-label={`${t('lang.label')}: ${t(`lang.${next}`)}`}>
      <Icon name="globe" size={16} />
      <span>{next === 'zh-CN' ? '中文' : 'EN'}</span>
    </button>
  );
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard blocked (insecure context): nothing to do
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={15} />
      {done ? t('common.copied') : t('common.copy')}
    </button>
  );
}
