import { useState } from 'react';
import { patch, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import { ImportModal } from '../components/ImportModal';
import { FieldDef, RecordForm, clean } from '../components/RecordForm';

const ROLES: [string, string][] = [['learner', 'Apprenant'], ['trainer', 'Formateur'], ['contact', 'Contact client'], ['tutor', 'Tuteur'], ['staff', 'Équipe interne']];
const TABS: [string, string][] = [['learner', 'Apprenants'], ['trainer', 'Formateurs'], ['contact', 'Contacts clients'], ['', 'Toutes les personnes']];
const KEYS = ['civility', 'firstName', 'lastName', 'email', 'email2', 'phone', 'mobile', 'birthDate', 'birthPlace', 'nationality', 'jobTitle', 'code', 'employerClientId'];
const toForm = (x: any) => ({ civility: x.civility, firstName: x.first_name, lastName: x.last_name, email: x.email, email2: x.email2, phone: x.phone, mobile: x.mobile,
  birthDate: x.birth_date ? String(x.birth_date).slice(0, 10) : '', birthPlace: x.birth_place, nationality: x.nationality, jobTitle: x.job_title, code: x.code,
  employerClientId: x.employer_client_id ?? '', address: x.address ?? {}, roles: x.roles ?? [], skills: (x.skills ?? []).join(', ') });
const toApi = (v: any) => ({ ...clean(v, KEYS), address: v.address ?? {}, roles: v.roles?.length ? v.roles : ['learner'],
  skills: String(v.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean) });

/** Apprenants, formateurs et contacts : liste, création, modification complète, archivage, import. */
export default function Persons() {
  const { org } = useApp();
  const write = can(org, 'crm.write');
  const [role, setRole] = useState('learner');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const list = useFetch<any[]>(`/api/v1/persons?limit=200&archived=${archived}${role ? `&role=${role}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, [role, q, archived]);
  const clients = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/clients?limit=200' : null);
  const act = useAction();
  const [edit, setEdit] = useState<any>(null);
  const [imp, setImp] = useState(false);
  const fields: FieldDef[] = [
    { key: 'civility', label: 'Civilité', type: 'select', options: [['M.', 'M.'], ['Mme', 'Mme']] }, { key: 'code', label: 'Code / matricule' },
    { key: 'firstName', label: 'Prénom', required: true }, { key: 'lastName', label: 'Nom', required: true },
    { key: 'email', label: 'Email', type: 'email' }, { key: 'email2', label: 'Email secondaire', type: 'email' },
    { key: 'phone', label: 'Téléphone' }, { key: 'mobile', label: 'Portable' },
    { key: 'birthDate', label: 'Date de naissance', type: 'date' }, { key: 'birthPlace', label: 'Lieu de naissance' },
    { key: 'nationality', label: 'Nationalité' }, { key: 'jobTitle', label: 'Fonction' },
    { key: 'employerClientId', label: 'Entreprise (employeur)', type: 'select', full: true, options: (clients.data ?? []).map((c) => [c.id, c.name] as [string, string]) },
    { key: 'address', label: 'Adresse', type: 'address' },
    { key: 'roles', label: 'Rôles', type: 'multi', options: ROLES },
    { key: 'skills', label: 'Compétences (formateur), séparées par des virgules', full: true },
  ];
  const label = TABS.find((t) => t[0] === role)?.[1] ?? 'Personnes';
  return (
    <>
      <h1>Apprenants & formateurs</h1>
      <div className="toolbar" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={role === k} className={`btn sm ${role === k ? '' : 'ghost'}`} onClick={() => setRole(k)}>{l}</button>)}
      </div>
      <div className="toolbar">
        <input placeholder="Rechercher (nom, email)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une personne" />
        <label className="row small"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Archivés</label>
        {write && <button className="btn" onClick={() => setEdit({ roles: [role || 'learner'] })}>Ajouter</button>}
        {can(org, 'imports.manage') && <button className="btn ghost" onClick={() => setImp(true)}>Importer (Excel / CSV)</button>}
      </div>
      {act.error && <p className="alert">{act.error}</p>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>Nom</th><th>Email</th><th>Téléphone</th><th>Entreprise</th><th>Rôles</th><th /></tr></thead>
          <tbody>{list.data?.length === 0 && <tr><td colSpan={6} className="muted">Aucune personne dans « {label} ».</td></tr>}
            {list.data?.map((x) => <tr key={x.id}>
              <td>{x.civility ? `${x.civility} ` : ''}{x.last_name} {x.first_name}</td><td>{x.email ?? '—'}</td><td>{x.mobile ?? x.phone ?? '—'}</td><td>{x.employer_name ?? '—'}</td>
              <td>{x.roles.map((r: string) => ROLES.find((y) => y[0] === r)?.[1] ?? r).join(', ')}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{write && <>
                <button className="btn ghost sm" onClick={() => setEdit(x)}>Modifier</button>
                <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/persons/${x.id}/archive`, { archived: !x.archived_at }), list.reload)}>{x.archived_at ? 'Restaurer' : 'Archiver'}</button>
              </>}</td></tr>)}</tbody></table>
        <p className="small muted">Archiver masque la personne des listes ; son historique (inscriptions, émargements, documents) est conservé.</p>
      </div>
      {edit && <RecordForm title={edit.id ? `Modifier — ${edit.first_name} ${edit.last_name}` : 'Nouvelle personne'} fields={fields} initial={edit.id ? toForm(edit) : edit} onClose={() => setEdit(null)}
        onSave={async (v) => {
          const body = toApi(v);
          if (edit.id) await patch(`/api/v1/persons/${edit.id}`, { ...body, version: edit.version });
          else { const r: any = await post('/api/v1/persons', body); if (r.possibleDuplicates?.length) alert('Attention : homonyme ou email déjà utilisé (aucune fusion automatique).'); }
          list.reload();
        }} />}
      {imp && <ImportModal title={`Importer des ${role === 'trainer' ? 'formateurs' : role === 'contact' ? 'contacts' : 'apprenants'}`} entity="person" role={(role || 'learner') as any} onClose={() => setImp(false)} onDone={list.reload} />}
    </>
  );
}
