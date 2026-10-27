import { useState } from 'react';
import { api, download } from '../api';
import { useFetch } from '../hooks';

const SEV: Record<string, [string, string]> = { blocking: ['Bloquant', 'err'], normal: ['Gênant', 'warn'], minor: ['Mineur', ''] };
const CAT: Record<string, string> = { bug: 'Bug', question: 'Question', evolution: 'Évolution' };
const STATUS: [string, string][] = [['new', 'Nouveau'], ['in_progress', 'En cours'], ['fixed', 'Corrigé'], ['wont_fix', 'Non retenu'], ['duplicate', 'Doublon']];

/** Back-office : signalements « Signaler un problème », suivi et récapitulatif à transmettre pour correction. */
export function PlatformTickets() {
  const [status, setStatus] = useState('open');
  const [since, setSince] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const [anon, setAnon] = useState(true);
  const [mark, setMark] = useState(true);
  const [open, setOpen] = useState<string | null>(new URLSearchParams(location.search).get('ticket'));
  const qs = new URLSearchParams({ status, ...(since ? { since } : {}) }).toString();
  const list = useFetch<any>(`/api/v1/platform/tickets?${qs}`, [qs]);
  const [err, setErr] = useState<string | null>(null);
  const exp = (format: 'xlsx' | 'md') => {
    const p = new URLSearchParams({ format, status, onlyNew: String(onlyNew), anonymize: String(anon), mark: String(mark), ...(since ? { since } : {}) });
    download(`/api/v1/platform/tickets/export?${p}`, `signalements-${new Date().toISOString().slice(0, 10)}.${format}`).then(() => list.reload(), (e: any) => setErr(e.message));
  };
  const upd = (id: string, body: any) => api('PATCH', `/api/v1/platform/tickets/${id}`, body).then(() => list.reload(), (e: any) => setErr(e.message));
  const c = list.data?.counts;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ marginBottom: 0 }}>Signalements {c && <span className="small muted">· {c.new} nouveau(x) · {c.in_progress} en cours · {c.not_exported} non encore transmis</span>}</h2>
      <div className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>Récapitulatif à m’envoyer pour correction</strong>
        <div className="toolbar" style={{ margin: 0, flexWrap: 'wrap' }}>
          <label className="row small">Statut<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Ouverts</option><option value="all">Tous</option>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="row small">Depuis<input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
          <label className="row small"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />Seulement ceux pas encore transmis</label>
          <label className="row small"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />Masquer les données personnelles</label>
          <label className="row small"><input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} />Marquer comme transmis</label>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="btn" onClick={() => exp('xlsx')}>Excel (.xlsx)</button>
          <button className="btn ghost" onClick={() => exp('md')}>Texte pour Claude (.md)</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Envoyez le fichier dans la conversation Claude Code : chaque ticket porte l’écran, la fonction, la description, le résultat attendu et les dernières erreurs serveur. Une fois corrigé, passez le ticket en « Corrigé » : l’utilisateur est prévenu par email.</p>
      </div>
      {err && <p className="alert">{err}</p>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="small"><thead><tr><th>Réf.</th><th>Date</th><th>Gravité</th><th>Type</th><th>Organisme</th><th>Écran / fonction</th><th>Description</th><th>Statut</th></tr></thead>
          <tbody>{list.data?.tickets.length === 0 && <tr><td colSpan={8} className="muted">Aucun signalement.</td></tr>}
            {list.data?.tickets.map((t: any) => [
              <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <td><strong>{t.ref}</strong>{!t.exported_at && <span className="pill warn"> nouveau</span>}</td><td>{new Date(t.created_at).toLocaleString('fr-FR')}</td>
                <td><span className={`pill ${SEV[t.severity]?.[1]}`}>{SEV[t.severity]?.[0]}</span></td><td>{CAT[t.category]}</td><td>{t.tenant_name ?? '—'}</td>
                <td>{t.feature ?? t.screen}<div className="muted">{t.screen}</div></td><td>{t.message.slice(0, 120)}{t.message.length > 120 ? '…' : ''}</td>
                <td onClick={(e) => e.stopPropagation()}><select aria-label={`Statut ${t.ref}`} value={t.status} onChange={(e) => upd(t.id, { status: e.target.value })}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              </tr>,
              open === t.id && <tr key={`${t.id}-d`}><td colSpan={8}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div><strong>Description</strong><div style={{ whiteSpace: 'pre-wrap' }}>{t.message}</div></div>
                  {t.expected && <div><strong>Résultat attendu</strong><div style={{ whiteSpace: 'pre-wrap' }}>{t.expected}</div></div>}
                  <div className="muted">{t.user_email ?? '—'} · rôle {t.role ?? '—'} · {t.context?.userAgent ?? ''} {t.context?.viewport ?? ''}</div>
                  {t.context?.errors?.length > 0 && <div><strong>Dernières erreurs serveur</strong><ul>{t.context.errors.map((e: any, i: number) => <li key={i}><code>{e.method} {e.path}</code> → {e.status} {e.code} {e.message}</li>)}</ul></div>}
                  <form className="toolbar" style={{ margin: 0 }} onSubmit={(e) => { e.preventDefault(); upd(t.id, { resolution: (e.currentTarget.elements.namedItem('res') as HTMLInputElement).value || null }); }}>
                    <input name="res" defaultValue={t.resolution ?? ''} placeholder="Réponse / suivi (envoyé à l’utilisateur à la clôture)" style={{ minWidth: 360 }} />
                    <button className="btn sm">Enregistrer le suivi</button>
                  </form>
                </div>
              </td></tr>,
            ])}</tbody></table>
      </div>
    </div>
  );
}
