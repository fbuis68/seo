import { useEffect, useRef, useState } from 'react';
import { ApiError, download, session } from '../api';

type Entity = 'client' | 'person';
type Status = 'ok' | 'warning' | 'error' | 'duplicate';
const STATUS: Record<Status, [string, string]> = { ok: ['OK', 'ok'], warning: ['À vérifier', 'warn'], error: ['Erreur', 'err'], duplicate: ['Doublon', ''] };
const COLS: Record<Entity, [string, string][]> = {
  client: [['external_id', 'Code'], ['name', 'Raison sociale'], ['siret', 'SIRET'], ['email', 'Email'], ['phone', 'Téléphone'], ['address', 'Adresse'], ['postal_code', 'CP'], ['city', 'Ville']],
  person: [['civility', 'Civ.'], ['first_name', 'Prénom'], ['last_name', 'Nom'], ['email', 'Email'], ['phone', 'Téléphone'], ['birth_date', 'Naissance'], ['job_title', 'Fonction'], ['city', 'Ville'], ['client_ref', 'Code client']],
};
const WORD: Record<Entity, [string, string]> = { client: ['client', 'clients'], person: ['personne', 'personnes'] };
const FEM: Record<Entity, string> = { client: '', person: 'e' }; // accord : client importé, personne importée

/** Envoi brut du fichier (corps binaire) avec la correspondance des colonnes. */
async function send(path: string, file: File, mapping: (string | null)[] | null) {
  const s = session.get();
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) };
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (s?.tenantId) headers['X-Tenant-Id'] = s.tenantId;
  if (mapping) headers['X-Mapping'] = encodeURIComponent(JSON.stringify(mapping));
  const res = await fetch(path, { method: 'POST', headers, body: file });
  const json = await res.json().catch(() => ({}));
  if (res.status === 402) window.dispatchEvent(new CustomEvent('tms:upgrade', { detail: json }));
  if (!res.ok) throw { status: res.status, code: json.code, message: json.message ?? res.statusText } as ApiError;
  return json;
}

/**
 * Import rapide de clients ou d'apprenants (parcours Serv-Izy) : un fichier, la correspondance colonne par colonne
 * proposée puis modifiable, l'aperçu recalculé à chaque changement, l'import en un clic.
 */
export function QuickImport({ entity, role = 'learner', onDone, onCancel }: { entity: Entity; role?: 'learner' | 'trainer' | 'contact'; onDone?: () => void; onCancel?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<(string | null)[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [drag, setDrag] = useState(false);
  const req = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const qs = (sh: string | null) => `?role=${role}${sh ? `&sheet=${encodeURIComponent(sh)}` : ''}`;
  const [one, many] = WORD[entity];
  const e = FEM[entity];
  const acc = (n: number, w: string) => `${w}${e}${n > 1 ? 's' : ''}`;

  const analyze = async (f: File, m: (string | null)[] | null, sh: string | null) => {
    const id = ++req.current;
    setLoading(true); setError(null);
    try {
      const p = await send(`/api/v1/imports/quick/${entity}/preview${qs(sh)}`, f, m);
      if (id !== req.current) return;
      setPreview(p); setMapping(p.mapping); setSheet(p.sheet);
    } catch (e: any) { if (id === req.current) { setError(e.message); if (!m) setPreview(null); } }
    finally { if (id === req.current) setLoading(false); }
  };
  const pick = (f?: File) => { if (!f) return; setFile(f); setPreview(null); setMapping(null); setResult(null); setSheet(null); analyze(f, null, null); };
  const change = (col: number, value: string) => {
    if (!file || !mapping) return;
    const next = [...mapping];
    const field = preview?.fields.find((x: any) => x.key === value);
    if (field && !field.multiple) next.forEach((v, i) => { if (v === value && i !== col) next[i] = null; });
    next[col] = value || null;
    setMapping(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => analyze(file, next, sheet), 250);
  };
  const commit = async () => {
    if (!file || !mapping) return;
    setImporting(true); setError(null);
    try { setResult(await send(`/api/v1/imports/quick/${entity}/commit${qs(sheet)}`, file, mapping)); onDone?.(); }
    catch (e: any) { setError(e.message); } finally { setImporting(false); }
  };
  const reset = () => { setResult(null); setFile(null); setPreview(null); setMapping(null); setSheet(null); };

  if (result) return (
    <div className="panel stack" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 40, color: 'var(--ok, #15803d)' }} aria-hidden>✓</div>
      <p style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{result.created} {result.created > 1 ? many : one} {acc(result.created, 'importé')}{result.updated ? `, ${result.updated} ${acc(result.updated, 'mis')} à jour` : ''}</p>
      <ul className="small muted" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {result.skippedDuplicates > 0 && <li>{result.skippedDuplicates} doublon(s) ignoré(s)</li>}
        {result.errors + result.rejected > 0 && <li>{result.errors + result.rejected} ligne(s) en erreur non importée(s)</li>}
      </ul>
      <p className="small muted" style={{ margin: 0 }}>L’import est annulable depuis la liste des imports (« Annuler l’import »).</p>
      <div className="toolbar" style={{ justifyContent: 'center', margin: 0 }}>
        {onCancel && <button className="btn" onClick={onCancel}>Voir la liste</button>}
        <button className="btn ghost" onClick={reset}>Importer un autre fichier</button>
      </div>
    </div>
  );

  const shown = preview ? new Set((mapping ?? []).filter(Boolean)) : new Set<string>();
  if (shown.has('full_name')) ['civility', 'first_name', 'last_name'].forEach((k) => shown.add(k));
  const cols = COLS[entity].filter(([k]) => shown.has(k) || (entity === 'person' ? ['first_name', 'last_name'] : ['name']).includes(k));
  return (
    <div className="stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="small muted">Fichier Excel (.xlsx) ou CSV : une ligne par {one}, les en-têtes en première ligne.</span>
        <button className="btn ghost sm" onClick={() => download('/api/v1/imports/templates/clients-apprenants.xlsx', 'modele-clients-apprenants.xlsx')}>Télécharger le modèle</button>
      </div>
      <input ref={input} type="file" hidden accept=".xlsx,.xlsm,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <button type="button" className={`qi-drop ${drag ? 'over' : ''}`} onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
        <span style={{ fontSize: 28 }} aria-hidden>{file ? '📄' : '⇪'}</span>
        <strong>{file ? file.name : 'Choisir ou déposer un fichier'}</strong>
        <span className="small muted">{file ? 'Cliquer pour changer de fichier' : '.xlsx ou .csv — 10 Mo maximum'}</span>
      </button>
      {error && <p className="alert" role="alert">{error}</p>}
      {loading && !preview && <p className="muted">Analyse du fichier…</p>}

      {preview && mapping && <>
        {preview.sheets.length > 1 && <label className="row small">Onglet<select value={sheet ?? ''} onChange={(e) => { setSheet(e.target.value); setMapping(null); analyze(file!, null, e.target.value); }}>
          {preview.sheets.map((s: string) => <option key={s} value={s}>{s.split('#').pop()}</option>)}</select></label>}

        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Correspondance des colonnes</strong>{loading && <span className="small muted">Mise à jour…</span>}</div>
          <p className="small muted" style={{ marginTop: 4 }}>Proposée automatiquement d’après les en-têtes de « {preview.sheetName} ». Corrigez si besoin.</p>
          {preview.missing?.length > 0 && <p className="alert small">Associez une colonne au champ : {preview.missing.join(', ')}.</p>}
          <ul className="qi-map">
            {preview.headers.map((h: string, col: number) => (
              <li key={col}>
                <div style={{ minWidth: 0 }}><div className="qi-h">{h || <em>(sans titre)</em>}</div><div className="small muted qi-h">{preview.samples[col] ? `ex. : ${preview.samples[col]}` : 'colonne vide'}</div></div>
                <span className="muted" aria-hidden>→</span>
                <select aria-label={`Champ pour la colonne ${h}`} value={mapping[col] ?? ''} onChange={(e) => change(col, e.target.value)} className={mapping[col] ? '' : 'muted'}>
                  <option value="">Ne pas importer</option>
                  {preview.fields.map((f: any) => <option key={f.key} value={f.key}>{f.label}{f.required ? ' *' : ''}</option>)}
                </select>
              </li>))}
          </ul>
        </div>

        <div className="panel">
          <strong>Aperçu</strong>
          <div className="toolbar" style={{ margin: '8px 0' }}>
            <span className="pill ok">{preview.stats.toImport} à importer</span>
            {preview.stats.warning > 0 && <span className="pill warn">{preview.stats.warning} à vérifier</span>}
            {preview.stats.duplicate > 0 && <span className="pill">{preview.stats.duplicate} doublon(s) ignoré(s)</span>}
            {preview.stats.error > 0 && <span className="pill err">{preview.stats.error} erreur(s)</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="small"><thead><tr><th>Ligne</th><th>Statut</th>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
              <tbody>{preview.rows.map((r: any) => <tr key={r.line} title={r.messages.join('\n')} style={r.status === 'error' ? { background: 'rgba(220,38,38,.06)' } : r.status === 'duplicate' ? { opacity: .55 } : undefined}>
                <td className="num">{r.line}</td><td><span className={`pill ${STATUS[r.status as Status][1]}`}>{STATUS[r.status as Status][0]}</span></td>
                {cols.map(([k]) => <td key={k} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.data[k] ?? ''}</td>)}</tr>)}</tbody></table>
          </div>
          {preview.stats.total > preview.rows.length && <p className="small muted">{preview.rows.length} premières lignes sur {preview.stats.total}.</p>}
        </div>

        {preview.issues.length > 0 && <div className="panel">
          <strong>Lignes à vérifier</strong>
          <ul className="qi-issues">{preview.issues.map((r: any) => (
            <li key={r.line}><span className="qi-line">Ligne {r.line}</span><span className={`pill ${STATUS[r.status as Status][1]}`}>{STATUS[r.status as Status][0]}</span>
              <span><strong>{entity === 'client' ? r.data.name : [r.data.first_name, r.data.last_name].filter(Boolean).join(' ')}{!(entity === 'client' ? r.data.name : r.data.last_name) && '—'}</strong><span className="muted"> · {r.messages.join(' · ')}</span></span></li>))}</ul>
        </div>}

        <div className="qi-bar">
          <span className="small">{preview.stats.toImport > 0 ? `${preview.stats.toImport} ${preview.stats.toImport > 1 ? many : one} ser${preview.stats.toImport > 1 ? 'ont' : 'a'} ${acc(preview.stats.toImport, 'créé')}.` : `Aucun${e} ${one} à importer avec cette correspondance.`} Les doublons et les lignes en erreur sont ignorés.</span>
          <span className="row" style={{ gap: 8 }}>
            {onCancel && <button className="btn ghost" onClick={onCancel}>Annuler</button>}
            <button className="btn" disabled={loading || importing || preview.stats.toImport === 0 || preview.missing?.length > 0} onClick={commit}>{importing ? 'Import…' : `Importer ${preview.stats.toImport} ${preview.stats.toImport > 1 ? many : one}`}</button>
          </span>
        </div>
      </>}
    </div>
  );
}
