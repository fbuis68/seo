import { useState } from 'react';
import { get, patch, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import { FieldDef, RecordForm } from '../components/RecordForm';

const MODALITY: [string, string][] = [['onsite', 'Présentiel'], ['remote', 'À distance'], ['blended', 'Mixte']];
const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Intitulé', required: true, full: true }, { key: 'code', label: 'Code' },
  { key: 'durationHours', label: 'Durée (heures)', type: 'number', required: true }, { key: 'modality', label: 'Modalité', type: 'select', required: true, options: MODALITY },
  { key: 'priceHt', label: 'Prix HT (€)' }, { key: 'vatRate', label: 'TVA (%)' },
  { key: 'rncpCode', label: 'Code RNCP' }, { key: 'rsCode', label: 'Code RS' },
  { key: 'objectives', label: 'Objectifs', type: 'textarea' }, { key: 'prerequisites', label: 'Prérequis', type: 'textarea' },
  { key: 'audience', label: 'Public visé', type: 'textarea' }, { key: 'evaluation', label: 'Modalités d’évaluation', type: 'textarea' },
  { key: 'isPublic', label: 'Publiée au catalogue public (site web)', type: 'checkbox' },
];
const num = (s: any) => (s === '' || s == null ? null : Number(String(s).replace(',', '.')));
const toApi = (v: any) => ({
  title: v.title, code: v.code || null, durationMinutes: Math.round((num(v.durationHours) ?? 0) * 60), modality: v.modality,
  priceHt: num(v.priceHt) != null ? num(v.priceHt)!.toFixed(2) : null, vatRate: v.vatRate === '' || v.vatRate == null ? null : String(v.vatRate).replace(',', '.'),
  rncpCode: v.rncpCode || null, rsCode: v.rsCode || null, objectives: v.objectives ?? '', prerequisites: v.prerequisites ?? '', audience: v.audience ?? '', evaluation: v.evaluation ?? '', isPublic: !!v.isPublic,
});

/** Catalogue des formations : création, modification (nouvelle version si déjà utilisée), archivage. */
export default function Programs() {
  const { org } = useApp();
  const write = can(org, 'catalog.write');
  const list = useFetch<any[]>('/api/v1/programs?limit=200');
  const act = useAction();
  const [edit, setEdit] = useState<any>(null);
  const open = (id?: string) => id ? act.run(() => get(`/api/v1/programs/${id}`), (p: any) => {
    const v = p.versions[0];
    setEdit({ id, init: { title: p.title, code: p.code, rncpCode: p.rncp_code, rsCode: p.rs_code, isPublic: p.is_public, durationHours: v.duration_minutes / 60, modality: v.modality,
      priceHt: v.price_ht ?? '', vatRate: v.vat_rate ?? '', objectives: v.objectives, prerequisites: v.prerequisites, audience: v.audience, evaluation: v.evaluation }, version: v.version });
  }) : setEdit({ init: { modality: 'onsite', durationHours: 7, vatRate: '20' } });
  return (
    <>
      <h1>Formations</h1>
      <div className="toolbar">{write && <button className="btn" onClick={() => open()}>Nouvelle formation</button>}</div>
      {act.error && <p className="alert">{act.error}</p>}
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table><thead><tr><th>Intitulé</th><th>Code</th><th className="num">Durée</th><th>Modalité</th><th className="num">Prix HT</th><th>Version</th><th /></tr></thead>
          <tbody>{list.data?.length === 0 && <tr><td colSpan={7} className="muted">Aucune formation.</td></tr>}
            {list.data?.map((p) => <tr key={p.id}><td>{p.title}{p.is_public && <span className="pill ok"> public</span>}</td><td>{p.code ?? '—'}</td><td className="num">{p.duration_minutes / 60} h</td>
              <td>{MODALITY.find((m) => m[0] === p.modality)?.[1]}</td><td className="num">{p.price_ht ?? '—'}</td><td>v{p.current_version}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{write && <>
                <button className="btn ghost sm" onClick={() => open(p.id)}>Modifier</button>
                <button className="btn ghost sm" onClick={() => confirm(`Archiver « ${p.title} » ? Les sessions existantes ne sont pas touchées.`) && act.run(() => patch(`/api/v1/programs/${p.id}`, { archived: true }), list.reload)}>Archiver</button>
              </>}</td></tr>)}</tbody></table>
        <p className="small muted">Une formation déjà utilisée par une session est modifiée dans une nouvelle version : les sessions, conventions et documents existants gardent la version d’origine.</p>
      </div>
      {edit && <RecordForm title={edit.id ? `Modifier la formation (v${edit.version})` : 'Nouvelle formation'} fields={FIELDS} initial={edit.init} onClose={() => setEdit(null)}
        onSave={async (v) => {
          if (edit.id) { const r: any = await patch(`/api/v1/programs/${edit.id}`, toApi(v)); if (r.newVersion) alert(`Formation déjà utilisée : nouvelle version v${r.versions[0].version} créée pour les prochaines sessions.`); }
          else await post('/api/v1/programs', toApi(v));
          list.reload();
        }} />}
    </>
  );
}
