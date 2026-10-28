import { useEffect, useState } from 'react';

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const l of listeners) l();
}

window.addEventListener('popstate', () => {
  for (const l of listeners) l();
});

/** Current pathname, re-rendering on navigation. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return path;
}
