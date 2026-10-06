/** Client HTTP de l'API : jeton de session + organisme courant (X-Tenant-Id) explicites. */
export interface ApiError { status: number; code: string; message: string; details?: any }

const KEY = 'tms.session';
export interface Session { token: string; tenantId?: string }
export const session = {
  get(): Session | null { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(s: Session | null) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* stockage indisponible */ } },
};

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { raw?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const s = session.get();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (s?.tenantId) headers['X-Tenant-Id'] = s.tenantId;
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body as BodyInit;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (opts.raw) { if (!res.ok) throw { status: res.status, code: 'http_error', message: res.statusText } as ApiError; return res as any; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { session.set(null); if (!location.pathname.startsWith('/login')) location.href = '/login'; }
    throw { status: res.status, code: json.code, message: json.message ?? res.statusText, details: json.details } as ApiError;
  }
  return json as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b);

export async function download(path: string, filename: string) {
  const res: Response = await api('GET', path, undefined, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const eur = (v: string | number | null | undefined, cur = 'EUR') =>
  v == null ? '—' : Number(v).toLocaleString('fr-FR', { style: 'currency', currency: cur });
export const date = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('fr-FR') : '—');
