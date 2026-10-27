import { useState } from 'react';
import { api, get, patch, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import { Help } from '../help';
import { ImportModal } from '../components/ImportModal';
import { FieldDef, RecordForm, clean } from '../components/RecordForm';

export const CLIENT_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Raison sociale / nom', required: true },
  { key: 'kind', label: 'Type', type: 'select', required: true, options: [['company', 'Entreprise'], ['person', 'Particulier']] },
  { key: 'siret', label: 'SIRET', hint: '14 chiffres' }, { key: 'vatNumber', label: 'N° TVA intracommunautaire' },
  { key: 'code', label: 'Code client' }, { key: 'ape', label: 'Code APE' },
  { key: 'billingEmail', label: 'Email de facturation', type: 'email' }, { key: 'phone', label: 'Téléphone' },
  { key: 'website', label: 'Site web' }, { key: 'paymentMethod', label: 'Moyen de paiement habituel' },
  { key: 'billingAddress', label: 'Adresse de facturation', type: 'address' },
  { key: 'isFunder', label: 'Financeur (OPCO, France Travail…)', type: 'checkbox' },
];
const CLIENT_KEYS = ['name', 'kind', 'siret', 'vatNumber', 'code', 'ape', 'billingEmail', 'phone', 'website', 'paymentMethod'];
const toForm = (x: any) => ({ name: x.name, kind: x.kind, siret: x.siret, vatNumber: x.vat_number, code: x.code, ape: x.ape, billingEmail: x.billing_email, phone: x.phone,
  website: x.website, paymentMethod: x.payment_method, billingAddress: x.billing_address ?? {}, isFunder: x.is_funder });
const toApi = (v: any) => ({ ...clean(v, CLIENT_KEYS), siret: v.siret ? String(v.siret).replace(/\s/g, '') : null, billingAddress: v.billingAddress ?? {}, isFunder: !!v.isFunder });

export default function Clients() {
  const { org } = useApp();
  const write = can(org, 'crm.write');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const clients = useFetch<any[]>(`/api/v1/clients?limit=200&archived=${archived}${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q, archived]);
  const act = useAction();
  const [edit, setEdit] = useState<any>(null); // fiche en cours de modification ({} = création)
  const [imp, setImp] = useState(false);
  const [sirene, setSirene] = useState<any[]>([]);
  const [lookup, setLookup] = useState('');
  const searchSirene = () => act.run(() => get(`/api/v1/opendata/search?source=sirene&q=${encodeURIComponent(lookup)}`), (r: any) => setSirene(r.results));
  return (
    <>
      <h1>Clients <Help k="clients" /></h1>
      <div className="toolbar">
        <input placeholder="Rechercher (nom, SIRET)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un client" />
        <label className="row small"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Archivés</label>
        {write && <button className="btn" onClick={() => setEdit({ kind: 'company' })}>Nouveau client</button>}
        {can(org, 'imports.manage') && <button className="btn ghost" onClick={() => setImp(true)}>Importer (Excel / CSV)</button>}
      </div>
      {write && <div className="toolbar small">
        <input placeholder="Trouver une entreprise (Sirene)…" value={lookup} onChange={(e) => setLookup(e.target.value)} aria-label="Recherche Sirene" />
        <button className="btn ghost sm" disabled={lookup.length < 3} onClick={searchSirene}>Rechercher dans Sirene</button>
        {sirene.length > 0 && <ul className="small" style={{ width: '100%' }}>{sirene.slice(0, 5).map((r) => <li key={r.siret}><a href="#" onClick={(e) => { e.preventDefault(); setEdit({ kind: 'company', name: r.name, siret: r.siret ?? '', billingAddress: { line1: r.address ?? '', postal_code: r.postalCode ?? r.postal_code ?? '', city: r.city ?? '' } }); setSirene([]); }}>{r.name}</a> — {r.siret} — {r.city} {!r.active && <span className="pill warn">fermé</span>}</li>)}<li className="muted">Source : Recherche d’entreprises (INSEE/DINUM), Licence Ouverte</li></ul>}
      </div>}
      {act.error && <p className="alert">{act.error}</p>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>Nom</th><th>SIRET</th><th>Email facturation</th><th>Ville</th><th>Statut</th><th /></tr></thead>
          <tbody>{clients.data?.length === 0 && <tr><td colSpan={6} className="muted">Aucun client.</td></tr>}
            {clients.data?.map((x) => <tr key={x.id}>
              <td>{x.name}{x.is_funder && <span className="pill"> financeur</span>}</td><td>{x.siret ?? '—'}</td><td>{x.billing_email ?? '—'}</td><td>{x.billing_address?.city ?? '—'}</td>
              <td><span className={`pill ${x.status === 'customer' ? 'ok' : ''}`}>{x.status === 'customer' ? 'client' : 'prospect'}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>{write && <>
                <button className="btn ghost sm" onClick={() => setEdit(x)}>Modifier</button>
                {x.status !== 'customer' && <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/clients/${x.id}/promote`), clients.reload)}>Passer client</button>}
                <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/clients/${x.id}/archive`, { archived: !x.archived_at }), clients.reload)}>{x.archived_at ? 'Restaurer' : 'Archiver'}</button>
                <button className="btn ghost sm" onClick={() => confirm(`Supprimer « ${x.name} » ? Impossible s’il a des factures, inscriptions ou règlements (archivez-le alors).`) && act.run(() => api('DELETE', `/api/v1/clients/${x.id}`), clients.reload)}>Supprimer</button>
              </>}</td></tr>)}</tbody></table>
        <p className="small muted">L’archivage masque la fiche sans libérer de place dans le quota Free des clients facturés.</p>
      </div>
      {edit && <RecordForm title={edit.id ? `Modifier — ${edit.name}` : 'Nouveau client'} fields={CLIENT_FIELDS} initial={edit.id ? toForm(edit) : { kind: 'company', ...edit }} onClose={() => setEdit(null)}
        onSave={async (v) => { edit.id ? await patch(`/api/v1/clients/${edit.id}`, { ...toApi(v), version: edit.version }) : await post('/api/v1/clients', { ...toApi(v), status: 'prospect' }); clients.reload(); }} />}
      {imp && <ImportModal title="Importer des clients" entity="client" onClose={() => setImp(false)} onDone={clients.reload} />}
    </>
  );
}
