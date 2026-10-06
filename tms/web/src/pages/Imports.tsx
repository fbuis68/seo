import { useState } from 'react';
import { api, download, post } from '../api';
import { useAction, useFetch } from '../hooks';

const ENTITY: Record<string, string> = { client: 'Clients', person: 'Personnes', program: 'Programmes', session: 'Sessions', enrollment: 'Inscriptions', attendance: 'Présences', invoice: 'Factures', payment: 'Règlements', document: 'Pièces' };

/** Assistant de reprise : sauvegarde déposée → détection → association → simulation → publication → rapport. */
export default function Imports() {
  const profiles = useFetch<any[]>('/api/v1/imports/profiles');
  const batches = useFetch<any[]>('/api/v1/imports');
  const act = useAction();
  const [software, setSoftware] = useState('dendreo');
  const [instance, setInstance] = useState('');
  const [batch, setBatch] = useState<any>(null);
  const [detect, setDetect] = useState<any>(null);
  const [sim, setSim] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [partial, setPartial] = useState(false);
  const profile = profiles.data?.find((p) => p.software === software);

  const upload = (file: File) => act.run(async () => {
    const b = await post('/api/v1/imports', { sourceSoftware: software, sourceInstanceId: instance || 'compte-principal' });
    const up = await api('PUT', `/api/v1/imports/${b.id}/package`, file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
    setBatch(up); setDetect(null); setSim(null); setReport(null);
    if (up.status !== 'rejected') setDetect(await post(`/api/v1/imports/${b.id}/detect`));
    batches.reload();
  });
  const simulate = (p: string) => act.run(async () => {
    await post(`/api/v1/imports/${batch.id}/mapping`, { profile: p });
    setSim(await post(`/api/v1/imports/${batch.id}/simulate`, { partial }));
  });

  return (
    <>
      <h1>Reprise de vos données</h1>
      <p className="muted">Reprise exclusivement à partir des fichiers de sauvegarde ou d’exports que vous déposez : aucun identifiant ni accès à votre ancien logiciel n’est demandé.</p>
      <div className="grid2">
        <div className="panel stack">
          <label>Logiciel d’origine<select value={software} onChange={(e) => setSoftware(e.target.value)}>
            <option value="dendreo">Dendreo</option><option value="digiforma">Digiforma</option><option value="generic">Autre / fichiers CSV-Excel</option><option value="native">Export de cette application</option></select></label>
          <label>Compte source (ex. nom de l’espace)<input value={instance} onChange={(e) => setInstance(e.target.value)} placeholder="compte-principal" /></label>
          {profile && <div className="small"><strong>Comment obtenir la sauvegarde :</strong> {profile.obtain}
            <ul>{profile.limits.map((l: string) => <li key={l}>{l}</li>)}</ul>
            {profile.status === 'provisional' && <span className="pill warn">Profil provisoire — compatibilité non garantie</span>}</div>}
          <label>Paquet (ZIP, CSV ou XLSX)<input type="file" accept=".zip,.csv,.xlsx" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} disabled={act.busy} /></label>
        </div>
        <div className="panel">
          <strong>Lots précédents</strong>
          <table><tbody>{batches.data?.map((b) => <tr key={b.id}><td>{b.source_software}</td><td>{b.status}</td><td>{new Date(b.created_at).toLocaleDateString('fr-FR')}</td>
            <td>{b.status === 'published' && <button className="btn ghost sm" onClick={() => confirm('Annuler ce lot (compensation) ?') && act.run(() => post(`/api/v1/imports/${b.id}/rollback`), () => batches.reload())}>Annuler le lot</button>}
              {['uploaded', 'detected', 'mapped', 'simulated', 'rejected'].includes(b.status) && <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/imports/${b.id}/cancel`), () => batches.reload())}>Abandonner</button>}</td></tr>)}</tbody></table>
        </div>
      </div>
      {act.error && <p className="alert" role="alert">{act.error}</p>}
      {batch?.status === 'rejected' && <div className="banner err"><strong>Paquet refusé :</strong> {batch.diagnostic.rejections.map((r: any) => `${r.message}${r.path ? ` (${r.path})` : ''}`).join(' · ')}</div>}
      {detect && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Détection</strong> <span className={`pill ${detect.verdict === 'recognized' ? 'ok' : 'warn'}`}>{detect.verdict}</span>
          {detect.message && <p className="muted">{detect.message}</p>}
          <table><thead><tr><th>Profil</th><th>Confiance</th><th>Fichiers associés</th><th /></tr></thead>
            <tbody>{detect.candidates.slice(0, 3).map((c: any) => <tr key={c.profile}><td>{c.label} <span className="small muted">v{c.version}</span></td><td>{Math.round(c.confidence * 100)} %</td>
              <td className="small">{c.files.map((f: any) => `${f.path} → ${ENTITY[f.entity]}`).join(', ') || '—'}</td>
              <td><button className="btn sm" disabled={c.confidence === 0 || act.busy} onClick={() => simulate(c.profile)}>Confirmer et simuler</button></td></tr>)}</tbody></table>
          <label className="row small"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Autoriser un import partiel (lignes en anomalie et leurs dépendances exclues)</label>
        </div>
      )}
      {sim && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Simulation (aucune donnée écrite)</strong>
          <table><thead><tr><th>Objet</th><th className="num">Lues</th><th className="num">Créées</th><th className="num">Mises à jour</th><th className="num">Inchangées</th><th className="num">Rejetées</th><th className="num">Exclues</th><th className="num">Alertes</th></tr></thead>
            <tbody>{Object.entries(sim.summary).map(([k, v]: any) => <tr key={k}><td>{ENTITY[k]}</td>{['read', 'create', 'update', 'unchanged', 'reject', 'exclude', 'warnings'].map((x) => <td key={x} className="num">{v[x]}</td>)}</tr>)}</tbody></table>
          {!sim.quota.fits && <div className="banner warn">{sim.quota.message} ({sim.quota.over.map((o: any) => `${o.quota} : ${o.projected}/${o.limit}`).join(', ')})</div>}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="btn ghost sm" onClick={() => download(`/api/v1/imports/${batch.id}/anomalies.csv`, 'anomalies.csv')}>Télécharger les anomalies (CSV)</button>
            <button className="btn" disabled={!sim.canCommit || act.busy} onClick={() => act.run(() => post(`/api/v1/imports/${batch.id}/commit`), (r) => { setReport(r); batches.reload(); })}>Publier les données</button>
          </div>
          {!sim.canCommit && sim.quota.fits && <p className="small muted">{sim.blocking} ligne(s) bloquante(s) : corrigez le paquet ou autorisez un import partiel puis relancez la simulation.</p>}
        </div>
      )}
      {report && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Rapport de reprise</strong> {report.balanced ? <span className="pill ok">100 % des lignes classées</span> : <span className="pill err">écart de classement</span>}
          <p className="small muted">{report.historicalNotice}</p>
          <table><thead><tr><th>Devise</th><th className="num">Factures</th><th className="num">TTC importé</th><th className="num">Écart (centimes)</th><th className="num">Incomplètes</th></tr></thead>
            <tbody>{report.financial.map((f: any) => <tr key={f.currency}><td>{f.currency}</td><td className="num">{f.invoices}</td><td className="num">{f.totalTtc}</td><td className="num">{f.differenceCents ?? '—'}</td><td className="num">{f.incomplete}</td></tr>)}</tbody></table>
          <details><summary>Colonnes non reprises</summary><ul className="small">{report.coverage.map((c: any) => <li key={c.file}>{c.file} : {c.ignoredColumns.join(', ') || 'aucune'}</li>)}</ul></details>
        </div>
      )}
    </>
  );
}
