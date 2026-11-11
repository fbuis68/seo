/** Client HTTP : jeton de session en mémoire + localStorage, erreurs structurées de l'API. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public details?: any) { super(message); }
}

const KEY = 'tn.token';
let token: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* navigation privée */ }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token && !path.startsWith('/api/auth/')) setToken(null);
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `Erreur ${res.status}`, data?.field, data?.details);
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = any>(p: string) => api<T>('DELETE', p);

/** Téléchargement authentifié (exports CSV/Excel). */
export async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.code, d.message ?? 'Export impossible'); }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const qrSrc = (path: string) => `/api/qr.svg?data=${encodeURIComponent(path)}`;
