import { date, post } from '../api';
import { useAction, useFetch } from '../hooks';

const STATUS: Record<string, [string, string]> = {
  uploaded: ['Déposé', 'warn'], detected: ['Analysé', 'warn'], mapped: ['Colonnes associées', 'warn'], simulated: ['Simulé, à publier', 'warn'], committing: ['Publication en cours', 'warn'],
  published: ['Publié', 'ok'], rolled_back: ['Annulé (données retirées)', ''], cancelled: ['Abandonné', ''], rejected: ['Fichier refusé', 'err'], failed: ['En échec', 'err'],
};
const ACTIVE = ['uploaded', 'detected', 'mapped', 'simulated'];
const total = (s: any) => Object.values(s ?? {}).reduce((a: any, e: any) => {
  a.read += e.read ?? 0; a.ok += (e.created ?? e.create ?? 0) + (e.updated ?? e.update ?? 0) + (e.unchanged ?? 0); a.ko += e.rejected ?? e.reject ?? 0; return a;
}, { read: 0, ok: 0, ko: 0 }) as any;

/** Lots d'import : reprendre, relancer depuis le même fichier, annuler (retrait des données) ou supprimer. */
export function ImportBatches({ onResume, reloadKey, onChange }: { onResume: (batchId: string) => void; reloadKey?: unknown; onChange?: () => void }) {
  const list = useFetch<any[]>('/api/v1/imports', [reloadKey]);
  const act = useAction();
  const done = () => { list.reload(); onChange?.(); };
  const relaunch = (b: any) => act.run(() => post<{ batchId: string }>(`/api/v1/imports/${b.id}/relaunch`), (r) => { done(); onResume(r.batchId); });
  const remove = async (b: any) => {
    if (b.status === 'published') {
      if (!confirm('Ce lot est publié. Le supprimer retire d’abord toutes les données qu’il a créées (refusé si elles ont été utilisées depuis, ex. facturées). Continuer ?')) return;
      return act.run(async () => { await post(`/api/v1/imports/${b.id}/rollback`); await post(`/api/v1/imports/${b.id}/delete`); }, done);
    }
    if (!confirm('Supprimer ce lot et son fichier ? Aucune donnée de votre espace n’est touchée.')) return;
    return act.run(async () => { if (ACTIVE.includes(b.status)) await post(`/api/v1/imports/${b.id}/cancel`); await post(`/api/v1/imports/${b.id}/delete`); }, done);
  };
  if (!list.data?.length) return null;
  return (
    <div className="panel" style={{ display: 'grid', gap: 6 }}>
      <strong>Imports effectués</strong>
      <div style={{ overflowX: 'auto' }}>
        <table className="small">
          <thead><tr><th>Date</th><th>Fichier</th><th>État</th><th className="num">Lignes</th><th className="num">Importées</th><th className="num">Rejetées</th><th>Actions</th></tr></thead>
          <tbody>{list.data.map((b) => {
            const t = total(b.summary); const st = STATUS[b.status] ?? [b.status, ''];
            return (
              <tr key={b.id}>
                <td>{date(b.created_at)}</td>
                <td>{b.filename ?? b.source_software}</td>
                <td><span className={`pill ${st[1]}`}>{st[0]}</span></td>
                <td className="num">{t.read || '—'}</td><td className="num">{t.read ? t.ok : '—'}</td><td className="num">{t.ko ? <strong style={{ color: 'var(--err, #b91c1c)' }}>{t.ko}</strong> : t.read ? 0 : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {ACTIVE.includes(b.status) && <button className="btn sm" disabled={act.busy} onClick={() => onResume(b.id)}>Reprendre</button>}
                  {['published', 'rolled_back', 'cancelled', 'failed'].includes(b.status) && b.package_sha256 && <button className="btn ghost sm" disabled={act.busy} title="Nouveau lot à partir du même fichier, colonnes déjà associées" onClick={() => relaunch(b)}>Relancer</button>}
                  {b.status === 'published' && <button className="btn ghost sm" disabled={act.busy} onClick={() => confirm('Annuler cet import ? Les données qu’il a créées seront retirées (refusé si elles ont été utilisées depuis). Le lot reste listé et peut être relancé.') && act.run(() => post(`/api/v1/imports/${b.id}/rollback`), done)}>Annuler l’import</button>}
                  {b.status !== 'committing' && <button className="btn ghost sm" disabled={act.busy} onClick={() => remove(b)}>Supprimer</button>}
                </td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      {act.error && <p className="alert small">{act.error}</p>}
      <p className="small muted" style={{ margin: 0 }}>« Relancer » reprend le même fichier avec les colonnes déjà associées : corrigez l’association si besoin, simulez, publiez. Pour un fichier corrigé, déposez-le simplement : les lignes déjà importées ne sont pas dupliquées.</p>
    </div>
  );
}
