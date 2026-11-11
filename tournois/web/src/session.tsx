import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { get, getToken, setToken } from './api';

export interface Me {
  user: { id: string; email: string; firstName: string; lastName: string; phone?: string };
  organizations: { id: string; name: string; role: string; plan: string; planLabel: string; limits: any }[];
  isPlatformAdmin: boolean;
}

interface SessionValue { me: Me | null; loading: boolean; refresh: () => Promise<void>; login: (token: string) => Promise<void>; logout: () => void; }
const Ctx = createContext<SessionValue>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await get<Me>('/api/me')); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const login = async (t: string) => { setToken(t); await refresh(); };
  const logout = () => { void fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); setToken(null); setMe(null); };
  return <Ctx.Provider value={{ me, loading, refresh, login, logout }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);

/** Chargement d'une ressource avec rechargement manuel. */
export function useData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(null); } catch (e) { setError(e as Error); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { setLoading(!!path); void reload(); }, [reload, path]);
  return { data, error, loading, reload, setData };
}

/**
 * Actualisation temps réel : flux SSE de l'API ; en cas d'interruption, rafraîchissement périodique
 * (repli §13.4) jusqu'au rétablissement du flux.
 */
export function useLive(streamPath: string | null, onUpdate: () => void) {
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  const [mode, setMode] = useState<'live' | 'polling' | 'off'>('off');
  useEffect(() => {
    if (!streamPath) return;
    let es: EventSource | null = null, poll: number | undefined, retry: number | undefined, timer: number | undefined, closed = false;
    const debounced = () => { window.clearTimeout(timer); timer = window.setTimeout(() => cb.current(), 250); };
    const startPolling = () => { setMode('polling'); if (!poll) poll = window.setInterval(() => cb.current(), 15_000); };
    const connect = () => {
      if (closed) return;
      const t = getToken();
      es = new EventSource(streamPath + (t && !streamPath.startsWith('/api/public') ? `?access_token=${encodeURIComponent(t)}` : ''));
      es.addEventListener('update', debounced);
      es.onopen = () => { setMode('live'); if (poll) { window.clearInterval(poll); poll = undefined; cb.current(); } };
      es.onerror = () => { es?.close(); startPolling(); retry = window.setTimeout(connect, 10_000); };
    };
    connect();
    const onVisible = () => { if (document.visibilityState === 'visible') cb.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { closed = true; es?.close(); window.clearInterval(poll); window.clearTimeout(retry); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [streamPath]);
  return mode;
}
