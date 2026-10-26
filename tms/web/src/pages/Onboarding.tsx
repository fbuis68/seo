import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, date, download, eur, get, patch, post } from '../api';
import { can, useApp } from '../context';
import { Help } from '../help';
import { ImportWizard } from '../components/ImportWizard';
import { useAction, useFetch } from '../hooks';

const STATE: Record<string, [string, string]> = {
  to_do: ['À compléter', ''], in_progress: ['En cours', 'warn'], error: ['En erreur', 'err'], to_validate: ['À valider', 'warn'], done: ['Validé', 'ok'], deferred: ['Différé', ''],
};
const STATUS: Record<string, string> = {
  new: 'Nouveau', collect: 'Collecte des données', import: 'Import en cours', configuration: 'Configuration', validation: 'Validation', ready: 'Prêt à facturer', complete: 'Reprise complète', suspended: 'Suspendu',
};
const READY: Record<string, string> = { not_ready: 'Pas encore prêt', ready_to_prepare: 'Prêt à préparer', ready_to_issue: 'Prêt à émettre', ready_to_transmit: 'Prêt à transmettre' };
const PATHS = [
  { key: 'start', title: 'Je démarre', text: 'Je crée mes clients et mes formations directement dans l’application.' },
  { key: 'excel', title: 'Je reprends Excel', text: 'J’ai mes clients et mes formations dans des fichiers CSV ou Excel.' },
  { key: 'migrate', title: 'Je migre un logiciel', text: 'J’utilise un autre logiciel (MCDF, Dendreo, Digiforma…) et je reprends ses données.' },
];

/** Assistant de mise en service : 7 étapes, sauvegarde automatique, progression réelle. */
export default function Onboarding() {
  const { org } = useApp();
  const [st, setSt] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(new URLSearchParams(location.search).get('step'));
  const load = () => get('/api/v1/onboarding').then(setSt, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <p className="alert">{err}</p>;
  if (!st) return <p className="muted">Chargement…</p>;
  const cur = step ?? st.current;
  const s = st.steps.find((x: any) => x.key === cur) ?? st.steps[0];
  const canEdit = can(org, 'org.manage');

  return (
    <>
      <h1>Mise en service <Help k="onboarding" /></h1>
      <div className="panel" style={{ display: 'grid', gap: 8 }}>
        <div className="toolbar" style={{ margin: 0, justifyContent: 'space-between' }}>
          <span><strong>{STATUS[st.status] ?? st.status}</strong> · {st.progress} % · diagnostic : <span className={`pill ${st.readiness.canIssue ? 'ok' : 'warn'}`}>{READY[st.readiness.state]}</span></span>
        </div>
        <div className="meter"><span style={{ width: `${st.progress}%` }} /></div>
        <div className="small muted">
          {st.milestones.first_draft_at ? `Premier brouillon : ${date(st.milestones.first_draft_at)}` : 'Premier brouillon : à venir'}
          {' · '}{st.milestones.ready_at ? `Prêt à facturer : ${date(st.milestones.ready_at)}` : 'Prêt à facturer : à venir'}
          {' · '}{st.milestones.first_issue_at ? `Première facture émise : ${date(st.milestones.first_issue_at)}` : 'Première facture émise : à venir'}
        </div>
      </div>

      <ol className="onb-steps" aria-label="Étapes">
        {st.steps.map((x: any, i: number) => (
          <li key={x.key}>
            <button className={`onb-step ${x.key === cur ? 'active' : ''}`} aria-current={x.key === cur ? 'step' : undefined} onClick={() => setStep(x.key)}>
              <span className="onb-n">{i + 1}</span><span>{x.label}</span><span className={`pill ${STATE[x.state]?.[1] ?? ''}`}>{STATE[x.state]?.[0] ?? x.state}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="panel" style={{ display: 'grid', gap: 12 }}>
        <div className="toolbar" style={{ margin: 0, justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{s.label}</h2>
          <span className="toolbar" style={{ margin: 0 }}>
            {['data', 'finish'].includes(s.key) && canEdit && <button className="btn ghost sm" onClick={() => post('/api/v1/onboarding/defer', { key: s.key, deferred: s.state !== 'deferred' }).then(setSt)}>{s.state === 'deferred' ? 'Reprendre cette étape' : 'Différer'}</button>}
            <Link className="btn ghost sm" to="/aide">Demander de l’aide</Link>
          </span>
        </div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.requirements.map((r: any) => <li key={r.label} style={{ color: r.ok ? 'var(--ok, #1b7f4b)' : undefined }}>{r.ok ? '✓ ' : '○ '}{r.label}</li>)}</ul>
        {s.reason && <p className="alert small" style={{ margin: 0 }}>{s.reason}</p>}
        {s.key === 'company' && <CompanyStep st={st} setSt={setSt} canEdit={canEdit} />}
        {s.key === 'data' && <DataStep st={st} reload={load} />}
        {s.key === 'training' && <TrainingStep st={st} reload={load} />}
        {s.key === 'billing' && <BillingStep st={st} setSt={setSt} />}
        {s.key === 'check' && <CheckStep checks={st.readiness.checks} reload={load} />}
        {s.key === 'first_invoice' && <FirstInvoiceStep st={st} reload={load} />}
        {s.key === 'finish' && <FinishStep st={st} setSt={setSt} canEdit={canEdit} />}
        <div className="toolbar" style={{ margin: 0 }}>
          {st.steps.findIndex((x: any) => x.key === s.key) > 0 && <button className="btn ghost sm" onClick={() => setStep(st.steps[st.steps.findIndex((x: any) => x.key === s.key) - 1].key)}>Étape précédente</button>}
          {s.key !== 'finish' && <button className="btn sm" onClick={() => { load(); setStep(st.steps[st.steps.findIndex((x: any) => x.key === s.key) + 1].key); }}>Étape suivante</button>}
        </div>
      </div>
    </>
  );
}

function CompanyStep({ st, setSt, canEdit }: { st: any; setSt: (x: any) => void; canEdit: boolean }) {
  const org = useFetch<any>('/api/v1/organization');
  const [a, setA] = useState<any>(st.session.answers);
  const [o, setO] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (org.data) setO({ legal_name: org.data.legal_name, siret: org.data.siret ?? '', ...(org.data.address ?? {}) }); }, [org.data]);
  // Sauvegarde automatique de chaque modification valide (contrôle de version : autre appareil).
  const save = (path?: string, answers?: any) => patch('/api/v1/onboarding', { version: st.session.version, path, answers }).then(setSt, (e: any) => setMsg(e.message));
  const saveOrg = () => o && patch('/api/v1/organization', { legal_name: o.legal_name, siret: o.siret || null, address: { line1: o.line1 ?? '', line2: o.line2 ?? '', postal_code: o.postal_code ?? '', city: o.city ?? '', country: o.country ?? 'FR' } })
    .then(() => get('/api/v1/onboarding').then(setSt), (e: any) => setMsg(e.message));
  const field = (k: string, label: string, props: any = {}) => <label>{label}<input value={a[k] ?? ''} disabled={!canEdit} onChange={(e) => setA({ ...a, [k]: e.target.value })} onBlur={() => save(undefined, { [k]: props.type === 'number' ? Number(a[k]) || undefined : a[k] || undefined })} {...props} /></label>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="cards">
        {PATHS.map((p) => (
          <button key={p.key} disabled={!canEdit} className="panel card" style={{ textAlign: 'left', outline: st.session.path === p.key ? '2px solid var(--accent)' : undefined, cursor: 'pointer' }} onClick={() => save(p.key)}>
            <strong>{p.title}</strong><span className="small muted">{p.text}</span>
          </button>
        ))}
      </div>
      <div className="grid2">
        {field('activity', 'Activité')}{field('previousTool', 'Outil précédent')}
        {field('country', 'Pays (code, ex. FR)', { maxLength: 2 })}{field('currency', 'Devise (ex. EUR)', { maxLength: 3 })}
        {field('companies', 'Nombre de sociétés', { type: 'number', min: 1 })}{field('volume', 'Volume approximatif (clients / an)')}
      </div>
      {field('goal', 'Objectif immédiat (ex. facturer la session de mars)')}
      {o && <fieldset className="panel" style={{ display: 'grid', gap: 8 }}>
        <legend>Émetteur des factures</legend>
        <div className="grid2">
          <label>Raison sociale<input value={o.legal_name ?? ''} onChange={(e) => setO({ ...o, legal_name: e.target.value })} onBlur={saveOrg} disabled={!canEdit} /></label>
          <label>SIRET (14 chiffres)<input value={o.siret ?? ''} inputMode="numeric" maxLength={14} onChange={(e) => setO({ ...o, siret: e.target.value.replace(/\D/g, '') })} onBlur={saveOrg} disabled={!canEdit} /></label>
          <label>Adresse<input value={o.line1 ?? ''} onChange={(e) => setO({ ...o, line1: e.target.value })} onBlur={saveOrg} disabled={!canEdit} /></label>
          <label>Complément<input value={o.line2 ?? ''} onChange={(e) => setO({ ...o, line2: e.target.value })} onBlur={saveOrg} disabled={!canEdit} /></label>
          <label>Code postal<input value={o.postal_code ?? ''} onChange={(e) => setO({ ...o, postal_code: e.target.value })} onBlur={saveOrg} disabled={!canEdit} /></label>
          <label>Ville<input value={o.city ?? ''} onChange={(e) => setO({ ...o, city: e.target.value })} onBlur={saveOrg} disabled={!canEdit} /></label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Logo facultatif (Réglages) : son absence ne bloque pas la première facture.</p>
      </fieldset>}
      {msg && <p className="alert small">{msg}</p>}
    </div>
  );
}

function DataStep({ st, reload }: { st: any; reload: () => void }) {
  const p = st.session.path;
  const [show, setShow] = useState(p === 'excel');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0 }}>{st.counts.clients} client(s), {st.counts.programs} formation(s) dans votre espace.</p>
      {(!p || p === 'start') && <p style={{ margin: 0 }}>Créez vos premiers éléments : <Link to="/clients">un client</Link> (avec son adresse de facturation) et <Link to="/sessions">une formation</Link>. Vous avez déjà des listes ? <button className="linklike" onClick={() => setShow(!show)}>Importer un fichier Excel</button>.</p>}
      {p === 'migrate' && <p style={{ margin: 0 }}>Logiciel avec sauvegarde (MCDF, Dendreo, Digiforma…) : <Link to="/settings/reprise">Reprise des données</Link>. Clients et apprenants depuis Excel : <button className="linklike" onClick={() => setShow(!show)}>importer ici</button>.</p>}
      {(show || p === 'excel') && <ImportWizard simple onPublished={reload} />}
      {st.imports.length > 0 && <table className="small">
        <thead><tr><th>Source</th><th>État</th><th className="num">Reçus</th><th className="num">Importés</th><th className="num">Rejetés</th><th className="num">Exclus</th><th>Date</th></tr></thead>
        <tbody>{st.imports.map((b: any) => {
          const t = Object.values(b.summary ?? {}).reduce((acc: any, e: any) => { acc.read += e.read ?? 0; acc.created += (e.created ?? e.create ?? 0) + (e.updated ?? e.update ?? 0); acc.rejected += e.rejected ?? e.reject ?? 0; acc.excluded += e.excluded ?? e.exclude ?? 0; return acc; }, { read: 0, created: 0, rejected: 0, excluded: 0 }) as any;
          return <tr key={b.id}><td>{b.source}</td><td>{b.status}</td><td className="num">{t.read}</td><td className="num">{t.created}</td><td className="num">{t.rejected}</td><td className="num">{t.excluded}</td><td>{date(b.createdAt)}</td></tr>;
        })}</tbody>
      </table>}
    </div>
  );
}

const AREA: Record<string, string> = { catalog: 'Formation', trainer: 'Formateur', place: 'Lieu', session: 'Session', planning: 'Planning', learners: 'Apprenants', plan: 'Offre', documents: 'Documents' };
const iso = (d: string, h: string) => new Date(`${d}T${h}`).toISOString();

/** Mise en route d'une formation : tout ce qui bloque, avec création rapide de chaque prérequis. */
function TrainingStep({ st, reload }: { st: any; reload: () => void }) {
  const nav = useNavigate();
  const act = useAction();
  const programs = useFetch<any[]>('/api/v1/programs?limit=200');
  const trainers = useFetch<any[]>('/api/v1/persons?role=trainer&limit=200');
  const learners = useFetch<any[]>('/api/v1/persons?role=learner&limit=200');
  const rooms = useFetch<any[]>('/api/v1/resources');
  const clients = useFetch<any[]>('/api/v1/clients?limit=200');
  const start = st.start;
  const sid = start?.sessionId;
  const session = useFetch<any>(sid ? `/api/v1/sessions/${sid}` : null, [sid]);
  const places = (rooms.data ?? []).filter((r: any) => ['room', 'site'].includes(r.kind) && !r.archived_at);
  const refresh = () => { reload(); programs.reload(); trainers.reload(); learners.reload(); rooms.reload(); session.reload(); };
  const ok = (code: string) => start?.checks.find((c: any) => c.code === code)?.ok;
  const today = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const [pg, setPg] = useState({ title: '', hours: '7', modality: 'onsite', priceHt: '', vatRate: '20' });
  const [tr, setTr] = useState({ firstName: '', lastName: '', email: '' });
  const [rm, setRm] = useState({ name: 'Salle 1', capacity: '12', address: '' });
  const [se, setSe] = useState({ programId: '', kind: 'inter', clientId: '', startsOn: today, endsOn: today, capacity: '12' });
  const [sl, setSl] = useState({ day: today, from: '09:00', to: '17:00', trainerId: '', roomId: '', videoUrl: '' });
  const [le, setLe] = useState({ personId: '', firstName: '', lastName: '', email: '' });
  const [open, setOpen] = useState<string | null>(null);
  const show = (k: string, done: boolean) => !done || open === k;
  const program = programs.data?.find((p: any) => p.id === (se.programId || programs.data?.[0]?.id));
  const remote = start?.modality === 'remote';
  const toggle = (k: string) => <button type="button" className="linklike" onClick={() => setOpen(open === k ? null : k)}>{open === k ? 'Fermer' : 'Ajouter'}</button>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0 }}>Pour démarrer une formation il faut : une formation au catalogue, un formateur, une salle (sauf distanciel), une session datée et planifiée, des séances publiées au planning et des apprenants inscrits.</p>
      {start && <table className="small"><tbody>{start.checks.map((c: any) => (
        <tr key={c.code}><td>{c.ok ? '✓' : c.severity === 'blocking' ? '✕' : '!'}</td><td className="muted">{AREA[c.area]}</td><td>{c.message}</td>
          <td>{!c.ok && c.screen && !c.screen.startsWith('/onboarding') && <button className="btn ghost sm" onClick={() => nav(c.screen)}>Corriger</button>}</td></tr>))}</tbody></table>}

      <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>1. Formation {ok('program') && toggle('program')}</strong>
        {show('program', !!ok('program')) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/programs', { title: pg.title, durationMinutes: Math.round(Number(pg.hours.replace(',', '.')) * 60), modality: pg.modality, priceHt: pg.priceHt || null, vatRate: pg.vatRate || null }), (p: any) => { setSe({ ...se, programId: p.id }); setOpen(null); refresh(); }); }}>
          <label>Intitulé<input required minLength={2} value={pg.title} onChange={(e) => setPg({ ...pg, title: e.target.value })} placeholder="Ex. Habilitation électrique B0" /></label>
          <label>Durée (heures)<input required inputMode="decimal" value={pg.hours} onChange={(e) => setPg({ ...pg, hours: e.target.value })} /></label>
          <label>Modalité<select value={pg.modality} onChange={(e) => setPg({ ...pg, modality: e.target.value })}><option value="onsite">Présentiel</option><option value="remote">Distanciel</option><option value="blended">Mixte</option></select></label>
          <label>Prix HT (facultatif)<input inputMode="decimal" value={pg.priceHt} onChange={(e) => setPg({ ...pg, priceHt: e.target.value })} /></label>
          <div><button className="btn sm" disabled={act.busy}>Créer la formation</button></div>
        </form>}
      </section>

      <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>2. Formateur {ok('trainer') && toggle('trainer')}</strong>
        {ok('trainer') && <span className="small muted">{trainers.data?.map((t: any) => `${t.first_name} ${t.last_name}`).join(', ')}</span>}
        {show('trainer', !!ok('trainer')) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/persons', { firstName: tr.firstName, lastName: tr.lastName, email: tr.email || null, roles: ['trainer'] }), (p: any) => { setSl({ ...sl, trainerId: p.id }); setTr({ firstName: '', lastName: '', email: '' }); setOpen(null); refresh(); }); }}>
          <label>Prénom<input required value={tr.firstName} onChange={(e) => setTr({ ...tr, firstName: e.target.value })} /></label>
          <label>Nom<input required value={tr.lastName} onChange={(e) => setTr({ ...tr, lastName: e.target.value })} /></label>
          <label>Email (pour son planning)<input type="email" value={tr.email} onChange={(e) => setTr({ ...tr, email: e.target.value })} /></label>
          <div><button className="btn sm" disabled={act.busy}>Créer le formateur</button></div>
        </form>}
      </section>

      <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>3. Salle {ok('place') && toggle('place')}</strong>
        {ok('place') && <span className="small muted">{places.map((r: any) => r.name).join(', ')}</span>}
        {show('place', !!ok('place')) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/resources', { kind: 'room', name: rm.name, capacity: rm.capacity ? Number(rm.capacity) : null, address: rm.address || null }), (r: any) => { setSl({ ...sl, roomId: r.id }); setOpen(null); refresh(); }); }}>
          <label>Nom<input required value={rm.name} onChange={(e) => setRm({ ...rm, name: e.target.value })} /></label>
          <label>Capacité<input inputMode="numeric" value={rm.capacity} onChange={(e) => setRm({ ...rm, capacity: e.target.value })} /></label>
          <label>Adresse<input value={rm.address} onChange={(e) => setRm({ ...rm, address: e.target.value })} /></label>
          <div><button className="btn sm" disabled={act.busy}>Créer la salle</button></div>
        </form>}
      </section>

      <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>4. Session {sid && toggle('session')}</strong>
        {sid && <span className="small">« {start.sessionTitle} » — <Link to={`/sessions/${sid}`}>ouvrir la fiche</Link>{session.data?.status === 'draft' && <> · <button className="linklike" disabled={act.busy} onClick={() => act.run(() => post(`/api/v1/sessions/${sid}/status`, { status: 'planned' }), refresh)}>passer en « planifiée »</button></>}</span>}
        {show('session', !!sid) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); if (!program) return act.setError('Créez d’abord une formation.'); act.run(async () => {
          const s: any = await post('/api/v1/sessions', { programVersionId: program.current_version_id, kind: se.kind, clientId: se.kind === 'intra' ? se.clientId || null : null, startsOn: se.startsOn, endsOn: se.endsOn || se.startsOn, capacity: se.capacity ? Number(se.capacity) : null });
          await post(`/api/v1/sessions/${s.id}/status`, { status: 'planned' });
          return s;
        }, (s: any) => { setSl({ ...sl, day: se.startsOn }); setOpen(null); refresh(); void s; }); }}>
          <label>Formation<select required value={se.programId || program?.id || ''} onChange={(e) => setSe({ ...se, programId: e.target.value })}>{programs.data?.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          <label>Type<select value={se.kind} onChange={(e) => setSe({ ...se, kind: e.target.value })}><option value="inter">Inter-entreprises</option><option value="intra">Intra (un client)</option></select></label>
          {se.kind === 'intra' && <label>Client<select required value={se.clientId} onChange={(e) => setSe({ ...se, clientId: e.target.value })}><option value="">—</option>{clients.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label>Début<input type="date" required value={se.startsOn} onChange={(e) => setSe({ ...se, startsOn: e.target.value, endsOn: e.target.value > se.endsOn ? e.target.value : se.endsOn })} /></label>
          <label>Fin<input type="date" required min={se.startsOn} value={se.endsOn} onChange={(e) => setSe({ ...se, endsOn: e.target.value })} /></label>
          <label>Places<input inputMode="numeric" value={se.capacity} onChange={(e) => setSe({ ...se, capacity: e.target.value })} /></label>
          <div><button className="btn sm" disabled={act.busy || !programs.data?.length}>Créer et planifier la session</button></div>
        </form>}
      </section>

      {sid && <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>5. Séances au planning {ok('slots') && toggle('slot')}</strong>
        {ok('slots') && <span className="small"><Link to="/planning">Voir le planning</Link></span>}
        {show('slot', !!ok('slots')) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/planning/slots', {
          sessionId: sid, startsAt: iso(sl.day, sl.from), endsAt: iso(sl.day, sl.to), status: 'published', modality: remote ? 'remote' : 'onsite',
          trainerIds: [sl.trainerId || trainers.data?.[0]?.id].filter(Boolean), resourceIds: remote ? [] : [sl.roomId || places[0]?.id].filter(Boolean), videoUrl: remote ? sl.videoUrl || null : null,
        }), () => { setOpen(null); refresh(); }); }}>
          <label>Jour<input type="date" required value={sl.day} onChange={(e) => setSl({ ...sl, day: e.target.value })} /></label>
          <label>De<input type="time" required value={sl.from} onChange={(e) => setSl({ ...sl, from: e.target.value })} /></label>
          <label>À<input type="time" required value={sl.to} onChange={(e) => setSl({ ...sl, to: e.target.value })} /></label>
          <label>Formateur<select required value={sl.trainerId || trainers.data?.[0]?.id || ''} onChange={(e) => setSl({ ...sl, trainerId: e.target.value })}>{trainers.data?.map((t: any) => <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>)}</select></label>
          {!remote && <label>Salle<select required value={sl.roomId || places[0]?.id || ''} onChange={(e) => setSl({ ...sl, roomId: e.target.value })}>{places.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
          {remote && <label>Lien de visio<input type="url" required value={sl.videoUrl} onChange={(e) => setSl({ ...sl, videoUrl: e.target.value })} /></label>}
          <div><button className="btn sm" disabled={act.busy || !trainers.data?.length || (!remote && !places.length)}>Ajouter et publier la séance</button></div>
        </form>}
        <span className="small muted">Plusieurs jours ? Ajoutez une séance par demi-journée ou journée, ou utilisez le planning (duplication, série).</span>
      </section>}

      {sid && <section className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>6. Apprenants inscrits {ok('enrollments') && toggle('enroll')}</strong>
        {session.data?.enrollments?.length > 0 && <span className="small muted">{session.data.enrollments.filter((x: any) => x.status !== 'cancelled').map((x: any) => `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() || x.person_id).join(', ')}</span>}
        {show('enroll', !!ok('enrollments')) && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
          let personId = le.personId;
          if (!personId) personId = ((await post('/api/v1/persons', { firstName: le.firstName, lastName: le.lastName, email: le.email || null, roles: ['learner'] })) as any).id;
          return post(`/api/v1/sessions/${sid}/enrollments`, { personId, status: 'confirmed', clientId: session.data?.client_id ?? null });
        }, () => { setLe({ personId: '', firstName: '', lastName: '', email: '' }); refresh(); }); }}>
          <label>Apprenant existant<select value={le.personId} onChange={(e) => setLe({ ...le, personId: e.target.value })}><option value="">— nouvel apprenant —</option>{learners.data?.map((p: any) => <option key={p.id} value={p.id}>{p.last_name} {p.first_name}</option>)}</select></label>
          {!le.personId && <>
            <label>Prénom<input required value={le.firstName} onChange={(e) => setLe({ ...le, firstName: e.target.value })} /></label>
            <label>Nom<input required value={le.lastName} onChange={(e) => setLe({ ...le, lastName: e.target.value })} /></label>
            <label>Email<input type="email" value={le.email} onChange={(e) => setLe({ ...le, email: e.target.value })} /></label>
          </>}
          <div><button className="btn sm" disabled={act.busy}>Inscrire (confirmé)</button></div>
        </form>}
        <span className="small muted">Une liste d’apprenants ? Importez-la à l’étape « Données », puis inscrivez-les depuis la fiche session.</span>
      </section>}

      {act.error && <p className="alert">{act.error}</p>}
      {start?.ready && <p className="pill ok">Prêt à démarrer : la formation peut avoir lieu (émargement ouvert sur les séances publiées).</p>}
      <div><button className="btn ghost sm" onClick={refresh}>Relancer le diagnostic</button></div>
    </div>
  );
}

function BillingStep({ st, setSt }: { st: any; setSt: (x: any) => void }) {
  const { org } = useApp();
  const p = st.billing.profile;
  const [f, setF] = useState<any>({ vatRegime: '', paymentTermsDays: 30, paymentMethods: ['virement'], latePenalty: '3 fois le taux d’intérêt légal', fixedIndemnity: 40, showBankDetails: false, ...(p?.data ?? {}) });
  const ser = st.billing.series;
  const [sf, setSf] = useState<any>({ prefix: ser?.prefix ?? 'FAC-', nextNumber: Number(ser?.next_number ?? 1), legacyLastNumber: ser?.legacy_last_number ?? '', cutoverOn: ser?.cutover_on?.slice(0, 10) ?? '' });
  const act = useAction();
  const year = new Date().getFullYear();
  const canConfirm = can(org, 'invoices.issue');
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <fieldset className="panel" style={{ display: 'grid', gap: 8 }}>
        <legend>Règles fiscales et conditions {p?.confirmedAt ? <span className="pill ok">confirmées le {date(p.confirmedAt)}</span> : <span className="pill warn">à confirmer</span>}</legend>
        <div className="grid2">
          <label>Régime de TVA<select value={f.vatRegime ?? ''} onChange={(e) => setF({ ...f, vatRegime: e.target.value })}>
            <option value="">— à choisir (jamais déduit du pays) —</option><option value="subject">Assujetti à la TVA</option>
            <option value="exempt_261_4_4">Exonéré — formation professionnelle (art. 261-4-4° CGI)</option><option value="franchise_293b">Franchise en base (art. 293 B CGI)</option>
          </select></label>
          <label>N° de TVA intracommunautaire<input value={f.vatNumber ?? ''} onChange={(e) => setF({ ...f, vatNumber: e.target.value })} /></label>
          {f.vatRegime && f.vatRegime !== 'subject' && <label className="full">Mention d’exonération<input value={f.exemptionReason ?? st.billing.exemptionTexts[f.vatRegime] ?? ''} onChange={(e) => setF({ ...f, exemptionReason: e.target.value })} /></label>}
          <label>Délai de paiement (jours)<input type="number" min={0} max={120} value={f.paymentTermsDays ?? ''} onChange={(e) => setF({ ...f, paymentTermsDays: Number(e.target.value) })} /></label>
          <label>Moyens de paiement (séparés par des virgules)<input value={(f.paymentMethods ?? []).join(', ')} onChange={(e) => setF({ ...f, paymentMethods: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
          <label>Pénalités de retard<input value={f.latePenalty ?? ''} onChange={(e) => setF({ ...f, latePenalty: e.target.value })} /></label>
          <label>Indemnité forfaitaire de recouvrement (€)<input type="number" min={0} value={f.fixedIndemnity ?? 40} onChange={(e) => setF({ ...f, fixedIndemnity: Number(e.target.value) })} /></label>
          <label className="row"><input type="checkbox" checked={!!f.showBankDetails} onChange={(e) => setF({ ...f, showBankDetails: e.target.checked })} />Afficher les coordonnées bancaires sur les factures</label>
          {f.showBankDetails && <><label>IBAN<input value={f.iban ?? ''} onChange={(e) => setF({ ...f, iban: e.target.value })} /></label><label>BIC<input value={f.bic ?? ''} onChange={(e) => setF({ ...f, bic: e.target.value })} /></label></>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Prix saisis HT ; TVA et arrondi au centime par ligne, total = somme des lignes. Modifier le régime, le délai ou l’IBAN annule la confirmation.</p>
        {p?.problems?.length > 0 && <p className="alert small" style={{ margin: 0 }}>{p.problems.join(' ')}</p>}
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="btn ghost sm" disabled={act.busy} onClick={() => act.run(() => api('PUT', '/api/v1/billing-profile', { ...f, vatRegime: f.vatRegime || undefined, exemptionReason: f.exemptionReason || null, vatNumber: f.vatNumber || null, iban: f.iban || null, bic: f.bic || null }), setSt)}>Enregistrer</button>
          {p && !p.confirmedAt && canConfirm && <button className="btn sm" disabled={act.busy || p.problems.length > 0} onClick={() => act.run(() => post('/api/v1/billing-profile/confirm', { version: p.version }), setSt)}>Je confirme ces règles</button>}
          {!canConfirm && <span className="small muted">Confirmation réservée au responsable facturation.</span>}
        </div>
      </fieldset>
      <fieldset className="panel" style={{ display: 'grid', gap: 8 }}>
        <legend>Numérotation et bascule {ser?.confirmed_at ? <span className="pill ok">validée</span> : <span className="pill warn">à valider</span>}</legend>
        <div className="grid2">
          <label>Préfixe<input value={sf.prefix} onChange={(e) => setSf({ ...sf, prefix: e.target.value })} /></label>
          <label>Prochain numéro<input type="number" min={1} value={sf.nextNumber} onChange={(e) => setSf({ ...sf, nextNumber: Number(e.target.value) })} /></label>
          <label>Dernier numéro émis dans l’ancien outil<input value={sf.legacyLastNumber} placeholder={`ex. FAC-${year}-00150`} onChange={(e) => setSf({ ...sf, legacyLastNumber: e.target.value })} /></label>
          <label>Date de bascule (fin d’émission dans l’ancien outil)<input type="date" value={sf.cutoverOn} onChange={(e) => setSf({ ...sf, cutoverOn: e.target.value })} /></label>
        </div>
        <p className="small">Prochaine facture : <strong>{sf.prefix}{year}-{String(sf.nextNumber || 1).padStart(5, '0')}</strong>. Le numéro définitif est attribué à l’émission, jamais à l’aperçu ; les factures reprises gardent leur numéro.</p>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="btn ghost sm" disabled={act.busy} onClick={() => act.run(() => api('PUT', '/api/v1/invoice-series', { ...sf, legacyLastNumber: sf.legacyLastNumber || null, cutoverOn: sf.cutoverOn || null }), setSt)}>Enregistrer</button>
          {!ser?.confirmed_at && canConfirm && <button className="btn sm" disabled={act.busy} onClick={() => act.run(() => post('/api/v1/invoice-series/confirm', {}), setSt)}>Valider la numérotation</button>}
        </div>
      </fieldset>
      {act.error && <p className="alert">{act.error}</p>}
    </div>
  );
}

function CheckStep({ checks, reload }: { checks: any[]; reload: () => void }) {
  const nav = useNavigate();
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <table className="small"><tbody>{checks.map((c) => (
        <tr key={c.code}><td>{c.ok ? '✓' : c.severity === 'blocking' ? '✕' : '!'}</td><td>{c.message}</td><td className="muted">{c.severity === 'warning' ? 'avertissement' : c.level === 'prepare' ? 'préparer' : c.level === 'issue' ? 'émettre' : 'transmettre'}</td>
          <td>{!c.ok && c.screen && <button className="btn ghost sm" onClick={() => nav(c.screen)}>Corriger</button>}</td></tr>))}</tbody></table>
      <div><button className="btn ghost sm" onClick={reload}>Relancer le diagnostic</button></div>
    </div>
  );
}

function FirstInvoiceStep({ st, reload }: { st: any; reload: () => void }) {
  const { org } = useApp();
  const clients = useFetch<any[]>('/api/v1/clients?limit=200');
  const programs = useFetch<any[]>('/api/v1/programs');
  const [f, setF] = useState<any>({ clientId: '', label: '', quantity: '1', unitPriceHt: '', vatRate: st.billing.profile?.data?.vatRegime && st.billing.profile.data.vatRegime !== 'subject' ? '0' : '20' });
  const [draft, setDraft] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const act = useAction();
  const client = clients.data?.find((c) => c.id === (draft?.client_id ?? f.clientId));
  const check = (id: string) => get(`/api/v1/billing-readiness?invoiceId=${id}`).then(setDiag);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {!draft && <form className="grid2" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/invoices', { clientId: f.clientId, lines: [{ label: f.label, quantity: f.quantity, unitPriceHt: f.unitPriceHt, vatRate: f.vatRate }] }), (d: any) => { setDraft(d); check(d.id); reload(); }); }}>
        <label>Client<select required value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">—</option>{clients.data?.filter((c) => !c.archived_at).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Prestation<input required list="onb-programs" value={f.label} onChange={(e) => {
          const p = programs.data?.find((x: any) => x.title === e.target.value);
          setF({ ...f, label: e.target.value, unitPriceHt: p?.versions?.[0]?.price_ht ?? f.unitPriceHt });
        }} /><datalist id="onb-programs">{programs.data?.map((p: any) => <option key={p.id} value={p.title} />)}</datalist></label>
        <label>Quantité<input required value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></label>
        <label>Prix unitaire HT<input required value={f.unitPriceHt} onChange={(e) => setF({ ...f, unitPriceHt: e.target.value })} /></label>
        <label>TVA %<input required value={f.vatRate} onChange={(e) => setF({ ...f, vatRate: e.target.value })} /></label>
        <div><button className="btn" disabled={act.busy}>Créer le brouillon</button></div>
      </form>}
      {draft && <div className="panel" style={{ display: 'grid', gap: 8 }}>
        <strong>Brouillon — {client?.name}</strong>
        <table className="small"><tbody>{draft.lines.map((l: any) => <tr key={l.id}><td>{l.label}</td><td className="num">{Number(l.quantity)}</td><td className="num">{eur(l.unit_price_ht)}</td><td className="num">{Number(l.vat_rate)} %</td><td className="num">{eur(l.total_ht)}</td></tr>)}</tbody></table>
        <p>Total HT {eur(draft.total_ht)} · TVA {eur(draft.total_vat)} · <strong>TTC {eur(draft.total_ttc)}</strong></p>
        {diag && !diag.canIssue && <ul className="alert small" style={{ margin: 0 }}>{diag.blocking.filter((c: any) => c.level !== 'transmit').map((c: any) => <li key={c.code}>{c.message}</li>)}</ul>}
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'invoice', invoiceId: draft.id }), (d: any) => download(`/api/v1/documents/${d.id}/download`, d.filename))}>Aperçu PDF (sans numéro)</button>
          {draft.status === 'draft' && can(org, 'invoices.issue') && <button className="btn sm" disabled={act.busy || (diag && !diag.canIssue)} onClick={() => confirm(`Émettre définitivement la facture de ${eur(draft.total_ttc)} TTC pour ${client?.name} ? Un numéro sera attribué ; aucun envoi automatique.`) && act.run(() => post(`/api/v1/invoices/${draft.id}/issue`), (d: any) => { setDraft(d); reload(); })}>Émettre la facture</button>}
          {draft.status === 'issued' && <span className="pill ok">Émise : {draft.number} · échéance {date(draft.due_date)}</span>}
        </div>
      </div>}
      {act.error && <p className="alert">{act.error}</p>}
      <p className="small muted">Pas encore de prestation à facturer ? Vous pouvez terminer la configuration sans créer de facture fictive.</p>
    </div>
  );
}

function FinishStep({ st, setSt, canEdit }: { st: any; setSt: (x: any) => void; canEdit: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <ul style={{ margin: 0 }}>
        <li><Link to="/settings">Inviter l’équipe</Link> : responsable facturation (émet), chargé de reprise (sans émission).</li>
        <li><Link to="/settings/reprise">Reprendre l’historique</Link> : factures closes, documents, champs personnalisés ; sans effet sur la facturation en cours.</li>
        <li><Link to="/settings">Personnaliser</Link> : logo et couleurs des documents.</li>
      </ul>
      {canEdit && <div className="toolbar" style={{ margin: 0 }}>
        <button className="btn ghost sm" onClick={() => post('/api/v1/onboarding/defer', { key: 'invite' }).then(setSt)}>Inviter plus tard</button>
        <button className="btn ghost sm" onClick={() => post('/api/v1/onboarding/defer', { key: 'history' }).then(setSt)}>Historique plus tard</button>
        <button className="btn ghost sm" onClick={() => confirm('Valider que toutes les données du périmètre convenu sont reprises et rapprochées ?') && post('/api/v1/onboarding/close', { complete: true }).then(setSt)}>Reprise complète validée</button>
        <button className="btn sm" onClick={() => post('/api/v1/onboarding/close', {}).then(setSt)}>Terminer l’assistant</button>
      </div>}
      {st.session.closedAt && <p className="small muted">Assistant terminé le {date(st.session.closedAt)} : relances arrêtées. Il reste accessible depuis ce menu.</p>}
    </div>
  );
}
