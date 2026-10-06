import { useCallback, useEffect, useState } from 'react';
import { ApiError, get } from './api';

/** Chargement simple avec état d'erreur et rechargement. */
export function useFetch<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    get<T>(path).then((d) => { setData(d); setError(null); }, setError).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load, setData };
}

export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, onOk?: (r: T) => void) => {
    setBusy(true); setError(null);
    try { const r = await fn(); onOk?.(r); return r; } catch (e: any) { setError(e.message ?? 'Erreur'); } finally { setBusy(false); }
  };
  return { error, busy, run, setError };
}
