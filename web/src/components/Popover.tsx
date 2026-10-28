import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A button that opens a floating panel; closes on outside click or Escape. */
export function Popover({
  trigger,
  label,
  className,
  align = 'left',
  placement = 'bottom',
  children,
}: {
  trigger: ReactNode;
  label: string;
  className?: string;
  align?: 'left' | 'right';
  placement?: 'top' | 'bottom';
  children: (close: () => void) => ReactNode;
}) {
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
    <div className={`popover ${className ?? ''}`} ref={ref}>
      <button type="button" className="chip-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </button>
      {open ? (
        <div className={`popover-panel ${align} ${placement}`} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
