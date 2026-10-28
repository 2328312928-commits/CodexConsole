import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CodexStatusInfo } from '../../shared/api.js';
import { get } from './api';

interface CodexStatusCtx {
  status: CodexStatusInfo | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<CodexStatusCtx>({ status: null, refresh: async () => undefined });

/** Polls the Codex process/account status for the header, banners and composer. */
export function CodexStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CodexStatusInfo | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await get<CodexStatusInfo>('/api/codex/status'));
    } catch {
      // keep the last known status; auth loss is handled globally
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 20_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return <Ctx.Provider value={{ status, refresh }}>{children}</Ctx.Provider>;
}

export function useCodexStatus(): CodexStatusCtx {
  return useContext(Ctx);
}

export function limitSeverity(percent: number): '' | 'warn' | 'bad' {
  return percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : '';
}
