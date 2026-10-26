import { useEffect, useState } from 'react';
import { download, get } from '../api';

const ENTITY_ONE: Record<string, string> = { client: 'Client', person: 'Apprenant', contact: 'Contact', program: 'Formation', session: 'Session', enrollment: 'Inscription', invoice: 'Facture', payment: 'Règlement' };
const ACTION: Record<string, [string, string, string]> = { // [simulation, publié, style]
  create: ['Sera créé', 'Créé', 'ok'], update: ['Sera mis à jour', 'Mis à jour', 'ok'], unchanged: ['Inchangé', 'Inchangé', ''],
  reject: ['Rejeté', 'Rejeté', 'err'], exclude: ['Exclu', 'Exclu', ''],
};
const SEV: Record<string, [string, string]> = { blocking: ['Erreur', 'err'], fix: ['Corrigé', 'warn'], warning: ['Alerte', 'warn'], info: ['Info', ''] };
const TABS: [string, string][] = [['errors', 'Erreurs'], ['warnings', 'Alertes'], ['ok', 'Importées sans remarque'], ['all', 'Toutes les lignes']];
const PAGE = 50;

/** Résultat de l'import ligne à ligne : chaque erreur est référencée (feuille, ligne, colonne) avec sa correction. */
export function ImportResults({ batchId, published }: { batchId: string; published?: boolean }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [entity, setEntity] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const f = filter ?? 'errors';
  useEffect(() => {
    const p = new URLSearchParams({ filter: f, limit: String(PAGE), offset: String(offset) });
    if (entity) p.set('entity', entity); if (q.trim()) p.set('q', q.trim());
    get(`/api/v1/imports/${batchId}/results?${p}`).then((r: any) => {
      // Sans erreur : on ouvre directement sur toutes les lignes.
      if (filter === null && r.counts.errors === 0) { setFilter(r.counts.warnings ? 'warnings' : 'all'); return; }
      setD(r); setErr(null);
    }, (e) => setErr(e.message));
  }, [batchId, f, entity, q, offset, filter]);
  if (err) return <p className="alert">{err}</p>;
  if (!d) return <p className="muted small">Chargement du détail…</p>;
  const c = d.counts;
  const n: Record<string, number> = { errors: c.errors, warnings: c.warnings, ok: c.ok, all: c.total };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="toolbar" style={{ margin: 0, flexWrap: 'wrap' }}>
        {TABS.map(([k, l]) => <button key={k} className={`btn sm ${f === k ? '' : 'ghost'}`} onClick={() => { setFilter(k); setOffset(0); }}>
          {l} <span className={`pill ${k === 'errors' && n[k] ? 'err' : k === 'warnings' && n[k] ? 'warn' : ''}`}>{n[k]}</span></button>)}
        <select value={entity} onChange={(e) => { setEntity(e.target.value); setOffset(0); }} aria-label="Objet"><option value="">Tous les objets</option><option value="client">Clients</option><option value="person">Apprenants</option><option value="program">Formations</option></select>
        <input type="search" placeholder="Rechercher (nom, email…)" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        <button className="btn ghost sm" onClick={() => download(`/api/v1/imports/${batchId}/anomalies.csv`, 'anomalies.csv')}>Télécharger les anomalies (CSV)</button>
      </div>
      {f === 'errors' && c.errors > 0 && <p className="small" style={{ margin: 0 }}>
        {published ? 'Ces lignes n’ont pas été importées.' : 'Ces lignes ne seront pas importées.'} Corrigez les cellules indiquées dans votre fichier (même feuille, même ligne) puis redéposez-le : les lignes déjà importées ne sont pas dupliquées.</p>}
      <div style={{ overflowX: 'auto' }}>
        <table className="small">
          <thead><tr><th>Fichier / feuille</th><th className="num">Ligne</th><th>Objet</th><th>Nom</th><th>Résultat</th><th>Colonne</th><th>Problème</th><th>Correction</th></tr></thead>
          <tbody>{d.rows.length === 0 ? <tr><td colSpan={8} className="muted">Aucune ligne.</td></tr> : d.rows.flatMap((r: any, i: number) => {
            const a = ACTION[r.action] ?? [r.action, r.action, ''];
            const issues = r.issues.length ? r.issues : [null];
            return issues.map((x: any, j: number) => (
              <tr key={`${i}-${j}`} style={x?.severity === 'blocking' ? { background: 'var(--err-bg, rgba(220,38,38,.06))' } : undefined}>
                {j === 0 && <>
                  <td rowSpan={issues.length}>{r.sheet ?? r.file}{r.sheet && <div className="muted">{r.file}</div>}</td>
                  <td rowSpan={issues.length} className="num"><strong>{r.line}</strong></td>
                  <td rowSpan={issues.length}>{ENTITY_ONE[r.entity] ?? r.entity}</td>
                  <td rowSpan={issues.length}>{r.label ?? <span className="muted">—</span>}{r.email && r.label !== r.email && <div className="muted">{r.email}</div>}</td>
                  <td rowSpan={issues.length}><span className={`pill ${a[2]}`}>{published ? a[1] : a[0]}</span></td>
                </>}
                <td>{x?.column ? <><strong>{x.columnLetter ?? ''}</strong> {x.column}</> : x ? <span className="muted">ligne</span> : ''}</td>
                <td>{x ? <><span className={`pill ${SEV[x.severity]?.[1] ?? ''}`}>{SEV[x.severity]?.[0] ?? x.severity}</span> {x.message}</> : <span className="muted">—</span>}</td>
                <td className="muted">{x?.fix ?? ''}</td>
              </tr>));
          })}</tbody>
        </table>
      </div>
      {d.total > PAGE && <div className="toolbar" style={{ margin: 0 }}>
        <button className="btn ghost sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
        <span className="small muted">Lignes {offset + 1}–{Math.min(offset + PAGE, d.total)} sur {d.total}</span>
        <button className="btn ghost sm" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
      </div>}
    </div>
  );
}
