import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A small popover menu attached to a button. Closes on outside click or Escape. */
export function Menu({ label, icon = 'more', items, children }: { label: string; icon?: IconName; items: MenuItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn ghost icon small" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        {children ?? <Icon name={icon} size={16} />}
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon ? <Icon name={it.icon} size={15} /> : <span className="menu-gap" />}
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
