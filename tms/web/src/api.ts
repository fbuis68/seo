/** Client HTTP de l'API : jeton de session + organisme courant (X-Tenant-Id) explicites. */
export interface ApiError { status: number; code: string; message: string; details?: any }

const KEY = 'tms.session';
export interface Session { token: string; tenantId?: string }
export const session = {
  get(): Session | null { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(s: Session | null) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* stockage indisponible */ } },
};

/** Dernières erreurs serveur (10 max) : jointes au signalement « Signaler un problème ». */
export interface RecentError { at: string; method: string; path: string; status: number; code?: string; message?: string }
const recent: RecentError[] = [];
export const recentErrors = () => [...recent];
function remember(e: RecentError) {
  if (e.path.startsWith('/api/v1/support/')) return;
  recent.push({ ...e, path: e.path.split('?')[0], message: e.message?.slice(0, 300) });
  if (recent.length > 10) recent.shift();
  // Erreur inattendue (5xx, réseau) ou refus incompris : proposition de signalement.
  window.dispatchEvent(new CustomEvent('tms:api-error', { detail: e }));
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { raw?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const s = session.get();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (s?.tenantId) headers['X-Tenant-Id'] = s.tenantId;
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body as BodyInit;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(path, { method, headers, body: payload }); }
  catch (e: any) { remember({ at: new Date().toISOString(), method, path, status: 0, code: 'network_error', message: e?.message }); throw { status: 0, code: 'network_error', message: 'Serveur injoignable : vérifiez votre connexion.' } as ApiError; }
  if (opts.raw) { if (!res.ok) throw { status: res.status, code: 'http_error', message: res.statusText } as ApiError; return res as any; }
  const json = await res.json().catch(() => ({}));
  if (res.status === 413) throw { status: 413, code: 'payload_too_large', message: 'Envoi trop volumineux pour le serveur (limite du proxy nginx : client_max_body_size).' } as ApiError;
  if (!res.ok) {
    if (res.status !== 401) remember({ at: new Date().toISOString(), method, path, status: res.status, code: json.code, message: json.message ?? res.statusText });
    if (res.status === 401) { session.set(null); if (!location.pathname.startsWith('/login')) location.href = '/login'; }
    // Quota ou module hors offre : invitation globale à changer d'offre (en plus du message local).
    if (res.status === 402) window.dispatchEvent(new CustomEvent('tms:upgrade', { detail: { code: json.code, message: json.message, details: json.details } }));
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

/** Heures affichées et saisies dans le fuseau de la session (pas celui du navigateur). */
export const fmtDT = (d: string, tz?: string) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: tz });
export const fmtT = (d: string, tz?: string) => new Date(d).toLocaleTimeString('fr-FR', { timeStyle: 'short', timeZone: tz });
export const fmtDayT = (d: string, tz?: string) => new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz });
export function zonedIso(day: string, hm: string, tz?: string): string {
  if (!tz) return new Date(`${day}T${hm}:00`).toISOString();
  const [y, m, dd] = day.split('-').map(Number); const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, dd, hh, mm);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}
