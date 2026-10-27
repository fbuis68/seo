import { useEffect, useState } from 'react';
import { api, download, get, post } from '../api';
import { useAction, useFetch } from '../hooks';
import { ImportResults } from './ImportResults';

export const ENTITY: Record<string, string> = {
  client: 'Clients', person: 'Apprenants / personnes', program: 'Formations', session: 'Sessions', enrollment: 'Inscriptions', attendance: 'Présences', invoice: 'Factures', payment: 'Règlements', document: 'Pièces',
  reference: 'Référentiels', qualification: 'Compétences et diplômes', contact: 'Contacts entreprise', resource: 'Salles', tariff_price: 'Tarifs', slot: 'Créneaux',
  convention: 'Conventions / propositions', convention_line: 'Lignes de convention', convention_payer: 'Financeurs de convention', convention_attendee: 'Stagiaires de convention',
  installment: 'Échéancier', convention_staff: 'Commissions', cost: 'Frais', trainer_attendance: 'Émargement formateur', invoice_line: 'Lignes de facture',
  invoice_attendee: 'Stagiaires facturés', allocation: 'Lettrage règlements', site: 'Sites', availability: 'Indisponibilités', closure: 'Fermetures', trainer: 'Profils formateur',
};
const FIELD: Record<string, string> = {
  external_id: 'Identifiant source', name: 'Raison sociale / nom', kind: 'Type (entreprise / particulier)', siret: 'SIRET', email: 'Email', address: 'Adresse', postal_code: 'Code postal', city: 'Ville',
  is_funder: 'Financeur (oui/non)', is_customer: 'Client facturé (oui/non)', phone: 'Téléphone', vat_number: 'N° TVA', first_name: 'Prénom', last_name: 'Nom', role: 'Rôle (apprenant, contact, formateur)',
  client_ref: 'Code du client (employeur)', civility: 'Civilité', birth_date: 'Date de naissance', mobile: 'Portable', job_title: 'Fonction',
  code: 'Code', title: 'Intitulé', duration_hours: 'Durée (heures)', modality: 'Modalité', objectives: 'Objectifs', price_ht: 'Prix HT', vat_rate: 'Taux TVA', rncp_code: 'Code RNCP',
};
const RESULT = ['read', 'create', 'update', 'unchanged', 'reject', 'exclude', 'warnings'];
const RESULT_LABEL: Record<string, string> = { read: 'Lues', create: 'Créées', update: 'Mises à jour', unchanged: 'Inchangées', reject: 'Rejetées', exclude: 'Exclues', warnings: 'Alertes' };

/**
 * Reprise par fichier : dépôt → détection → association des colonnes (modifiable) → simulation
 * (aucune écriture) → publication → rapport. `simple` : clients et apprenants depuis Excel/CSV.
 */
export function ImportWizard({ simple, onPublished, resumeId, onResumed, defaultEntity = 'client' }: { simple?: boolean; onPublished?: () => void; resumeId?: string | null; onResumed?: () => void; defaultEntity?: 'client' | 'person' }) {
  const profiles = useFetch<any[]>('/api/v1/imports/profiles');
  const fields = useFetch<Record<string, Record<string, { required?: boolean }>>>('/api/v1/imports/fields');
  const act = useAction();
  const [software, setSoftware] = useState(simple ? 'generic' : 'dendreo');
  const [instance, setInstance] = useState('');
  const [batch, setBatch] = useState<any>(null);
  const [detect, setDetect] = useState<any>(null);
  const [files, setFiles] = useState<any[] | null>(null);
  const [profile, setProfile] = useState<string>('generic');
  const [sim, setSim] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [partial, setPartial] = useState(false);
  const [entities, setEntities] = useState<string[]>([]);
  const prof = profiles.data?.find((p) => p.software === software);

  const reset = () => { setBatch(null); setDetect(null); setFiles(null); setSim(null); setReport(null); };
  const upload = (file: File) => act.run(async () => {
    reset();
    const b = await post('/api/v1/imports', { sourceSoftware: software, sourceInstanceId: instance || (simple ? 'fichier-excel' : 'compte-principal') });
    const up = await api('PUT', `/api/v1/imports/${b.id}/package`, file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
    setBatch(up);
    if (up.status !== 'rejected') {
      const d = await post(`/api/v1/imports/${b.id}/detect`);
      setDetect(d);
      const best = d.candidates?.[0];
      setProfile(best?.profile ?? 'generic');
      if (!d.mcdf) setFiles(best?.files?.length ? best.files : (d.tables ?? []).map((t: any) => ({ path: t.name, entity: defaultEntity, columns: {} })));
    }
  });
  // Reprise d'un lot existant (bouton « Relancer ») : état, détection, colonnes associées et simulation déjà faite.
  useEffect(() => {
    if (!resumeId) return;
    act.run(async () => {
      reset();
      const b: any = await get(`/api/v1/imports/${resumeId}`);
      setSoftware(b.source_software); setInstance(b.source_instance_id);
      setBatch(b);
      const d: any = await post(`/api/v1/imports/${b.id}/detect`);
      setDetect(d);
      if (!d.mcdf) {
        const best = d.candidates?.[0];
        setProfile(b.profile_code ?? best?.profile ?? 'generic');
        setFiles(b.mapping?.files?.length ? b.mapping.files : best?.files?.length ? best.files : (d.tables ?? []).map((t: any) => ({ path: t.name, entity: defaultEntity, columns: {} })));
      }
      if (b.status === 'simulated' && b.simulation) setSim({ batchId: b.id, ...b.simulation });
    }).finally(() => onResumed?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);
  const abandon = () => batch && act.run(() => post(`/api/v1/imports/${batch.id}/cancel`), reset);
  const simulate = () => act.run(async () => {
    const body = detect?.mcdf ? { profile: 'mcdf', entityIds: entities } : { profile, files: (files ?? []).filter((f) => f.entity) };
    await post(`/api/v1/imports/${batch.id}/mapping`, body);
    setSim(await post(`/api/v1/imports/${batch.id}/simulate`, { partial }));
  });
  const table = (path: string) => detect?.tables?.find((t: any) => t.name === path);
  const missing = (f: any) => Object.entries(fields.data?.[f.entity] ?? {}).filter(([k, d]) => d.required && !f.columns[k]).map(([k]) => FIELD[k] ?? k);
  const blockingMap = (files ?? []).some((f) => f.entity && missing(f).length);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {simple && (
        <div className="panel" style={{ display: 'grid', gap: 6 }}>
          <strong>1. Préparez votre fichier</strong>
          <p className="small" style={{ margin: 0 }}>Un classeur Excel avec deux onglets : <strong>Clients</strong> (entreprises, financeurs, particuliers) et <strong>Apprenants</strong> (rattachés à leur client par la colonne « Code client »). Vos propres colonnes sont acceptées : vous les associerez à l’étape suivante. CSV accepté aussi (un fichier par liste, ou un ZIP).</p>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn ghost sm" onClick={() => download('/api/v1/imports/templates/clients-apprenants.xlsx', 'modele-reprise-clients-apprenants.xlsx')}>Télécharger le modèle Excel (avec exemples)</button>
            <button className="btn ghost sm" onClick={() => download('/api/v1/imports/templates/clients-apprenants.xlsx?vide=1', 'modele-reprise-clients-apprenants-vide.xlsx')}>Modèle vide</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Aucune macro ni formule n’est exécutée ; zéros initiaux et dates conservés. Rien n’est écrit avant votre validation de la simulation.</p>
        </div>
      )}
      <div className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>{simple ? '2. Déposez le fichier' : 'Dépôt'}</strong>
        {!simple && <>
          <label>Logiciel d’origine<select value={software} onChange={(e) => setSoftware(e.target.value)}>
            <option value="dendreo">Dendreo</option><option value="digiforma">Digiforma</option><option value="mcdf">MCDF (sauvegarde de la base MariaDB)</option><option value="generic">Autre / fichiers CSV-Excel</option><option value="native">Export de cette application</option></select></label>
          <label>Compte source (ex. nom de l’espace)<input value={instance} onChange={(e) => setInstance(e.target.value)} placeholder="compte-principal" /></label>
          {prof && <div className="small"><strong>Comment obtenir la sauvegarde :</strong> {prof.obtain}
            <ul>{prof.limits.map((l: string) => <li key={l}>{l}</li>)}</ul>
            {prof.status === 'provisional' && <span className="pill warn">Profil provisoire — compatibilité non garantie</span>}</div>}
        </>}
        <label>{software === 'mcdf' ? 'Sauvegarde (.sql ou .sql.gz)' : 'Fichier Excel (.xlsx), CSV ou ZIP'}
          <input type="file" accept={software === 'mcdf' ? '.sql,.gz' : '.xlsx,.csv,.zip'} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} disabled={act.busy} /></label>
        {act.busy && <p className="small muted" style={{ margin: 0 }}>Traitement…</p>}
      </div>
      {act.error && <p className="alert" role="alert">{act.error}</p>}
      {batch?.status === 'rejected' && <div className="banner err"><strong>Fichier refusé :</strong> {batch.diagnostic.rejections.map((r: any) => `${r.message}${r.path ? ` (${r.path})` : ''}`).join(' · ')}</div>}

      {detect?.mcdf && (
        <div className="panel">
          <strong>Sauvegarde MCDF</strong> <span className="pill ok">{detect.mcdf.tables} tables lues</span>
          <p className="muted small">Choisissez le ou les organismes MCDF à reprendre dans cet espace.</p>
          <table><thead><tr><th /><th>Organisme</th><th>Code</th><th className="num">Personnes</th><th className="num">Sessions</th><th className="num">Conventions</th><th className="num">Factures</th></tr></thead>
            <tbody>{detect.mcdf.entities.filter((e: any) => e.id).map((e: any) => <tr key={e.id}>
              <td><input type="checkbox" checked={entities.includes(e.id)} onChange={(ev) => setEntities(ev.target.checked ? [...entities, e.id] : entities.filter((x) => x !== e.id))} /></td>
              <td>{e.name}</td><td>{e.code}</td><td className="num">{e.persons}</td><td className="num">{e.sessions}</td><td className="num">{e.conventions}</td><td className="num">{e.invoices}</td></tr>)}</tbody></table>
          <button className="btn sm" disabled={!entities.length || act.busy} onClick={simulate}>Simuler la reprise</button>
        </div>
      )}

      {detect && !detect.mcdf && files && (
        <div className="panel" style={{ display: 'grid', gap: 10 }}>
          <strong>{simple ? '3. Vérifiez les colonnes' : 'Association des colonnes'}</strong>
          {detect.message && <p className="small muted" style={{ margin: 0 }}>{detect.message}</p>}
          {!simple && detect.candidates?.length > 1 && <label className="small">Profil<select value={profile} onChange={(e) => { setProfile(e.target.value); setFiles(detect.candidates.find((c: any) => c.profile === e.target.value)?.files ?? files); }}>
            {detect.candidates.map((c: any) => <option key={c.profile} value={c.profile}>{c.label} ({Math.round(c.confidence * 100)} %)</option>)}</select></label>}
          {files.map((f, i) => {
            const t = table(f.path);
            const miss = f.entity ? missing(f) : [];
            return (
              <fieldset key={f.path} className="panel" style={{ display: 'grid', gap: 8 }}>
                <legend>{f.path.includes('#') ? `Onglet « ${f.path.split('#').pop()} »` : f.path} · {t?.rows ?? 0} ligne(s)</legend>
                <label className="small">Contenu<select value={f.entity ?? ''} onChange={(e) => setFiles(files.map((x, j) => j === i ? { ...x, entity: e.target.value || null, columns: {} } : x))}>
                  <option value="">— ignorer ce tableau —</option>
                  {(simple ? ['client', 'person'] : Object.keys(fields.data ?? {})).map((k) => <option key={k} value={k}>{ENTITY[k] ?? k}</option>)}</select></label>
                {f.entity && <table className="small">
                  <thead><tr><th>Champ</th><th>Colonne du fichier</th><th>Exemple</th></tr></thead>
                  <tbody>{Object.entries(fields.data?.[f.entity] ?? {}).map(([k, d]) => {
                    const colName = f.columns[k] ?? '';
                    return <tr key={k}>
                      <td>{FIELD[k] ?? k}{d.required && <strong title="obligatoire"> *</strong>}</td>
                      <td><select value={colName} onChange={(e) => setFiles(files.map((x, j) => j === i ? { ...x, columns: Object.fromEntries(Object.entries({ ...x.columns, [k]: e.target.value }).filter(([, v]) => v)) } : x))}>
                        <option value="">—</option>{(t?.columns ?? []).map((c: string) => <option key={c} value={c}>{c}</option>)}</select></td>
                      <td className="muted">{colName ? (t?.samples ?? []).map((r: any) => r[colName]).filter(Boolean).slice(0, 2).join(' · ') : ''}</td>
                    </tr>;
                  })}</tbody>
                </table>}
                {miss.length > 0 && <p className="alert small" style={{ margin: 0 }}>Colonne obligatoire non associée : {miss.join(', ')}.</p>}
              </fieldset>
            );
          })}
          <label className="row small"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Autoriser un import partiel (lignes en anomalie et leurs dépendances exclues, listées dans le rapport)</label>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn" disabled={act.busy || blockingMap || !files.some((f) => f.entity)} onClick={simulate}>Simuler (rien n’est écrit)</button>
            <button className="btn ghost" disabled={act.busy} onClick={abandon}>Abandonner</button>
          </div>
        </div>
      )}

      {sim && (
        <div className="panel" style={{ display: 'grid', gap: 8 }}>
          <strong>{simple ? '4. Simulation' : 'Simulation'} (aucune donnée écrite)</strong>
          <table><thead><tr><th>Objet</th>{RESULT.map((x) => <th key={x} className="num">{RESULT_LABEL[x]}</th>)}</tr></thead>
            <tbody>{Object.entries(sim.summary).map(([k, v]: any) => <tr key={k}><td>{ENTITY[k] ?? k}</td>{RESULT.map((x) => <td key={x} className="num">{v[x] ?? 0}</td>)}</tr>)}</tbody></table>
          {!sim.quota.fits && <div className="banner warn">{sim.quota.message} ({sim.quota.over.map((o: any) => `${o.quota} : ${o.projected}/${o.limit}`).join(', ')})</div>}
          {software === 'mcdf' && sim.issues?.length > 0 && <details><summary>{sim.issues.length} alerte(s)</summary><ul className="small">{sim.issues.slice(0, 200).map((i: any, k: number) => <li key={k}><strong>{ENTITY[i.entity] ?? i.entity}</strong> {i.legacyId ? `#${i.legacyId}` : ''} : {i.message}</li>)}</ul></details>}
          {software !== 'mcdf' && <ImportResults key={sim.computedAt} batchId={batch.id} />}
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn ghost sm" onClick={() => download(`/api/v1/imports/${batch.id}/anomalies.csv`, 'anomalies.csv')}>Rapport des anomalies (ligne, colonne, correction)</button>
            <button className="btn" disabled={!sim.canCommit || act.busy} onClick={() => act.run(() => post(`/api/v1/imports/${batch.id}/commit`), (r) => { setReport(r); setSim(null); setFiles(null); setDetect(null); onPublished?.(); })}>Publier les données</button>
            <button className="btn ghost" disabled={act.busy} onClick={abandon}>Abandonner</button>
          </div>
          {!sim.canCommit && sim.quota.fits && <p className="small muted" style={{ margin: 0 }}>{sim.blocking} ligne(s) bloquante(s) : corrigez le fichier et redéposez-le (les lignes déjà reprises ne sont pas dupliquées), ou cochez l’import partiel et relancez la simulation.</p>}
        </div>
      )}

      {report && (
        <div className="panel" style={{ display: 'grid', gap: 6 }}>
          <strong>Rapport de reprise</strong> {report.balanced ? <span className="pill ok">100 % des lignes classées</span> : <span className="pill err">écart de classement</span>}
          <table><thead><tr><th>Objet</th><th className="num">Lues</th><th className="num">Créées</th><th className="num">Mises à jour</th><th className="num">Inchangées</th><th className="num">Rejetées</th><th className="num">Exclues</th></tr></thead>
            <tbody>{Object.entries(report.perEntity ?? {}).map(([k, v]: any) => <tr key={k}><td>{ENTITY[k] ?? k}</td>{['read', 'created', 'updated', 'unchanged', 'rejected', 'excluded'].map((x) => <td key={x} className="num">{v[x] ?? 0}</td>)}</tr>)}</tbody></table>
          <p className="small muted" style={{ margin: 0 }}>{report.historicalNotice}</p>
          {report.source?.software !== 'mcdf' && <><strong>Détail ligne par ligne</strong><ImportResults batchId={report.batchId} published /></>}
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn ghost sm" onClick={() => confirm('Annuler ce lot ? Les données créées par cet import seront retirées (refusé si elles ont été utilisées depuis).') && act.run(() => post(`/api/v1/imports/${report.batchId}/rollback`), () => { reset(); onPublished?.(); })}>Annuler cet import</button>
            <button className="btn ghost sm" onClick={reset}>Importer un autre fichier</button>
          </div>
        </div>
      )}
    </div>
  );
}
