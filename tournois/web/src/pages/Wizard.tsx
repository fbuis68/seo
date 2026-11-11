import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../api';
import { ErrorBox, useAction } from '../components/ui';
import { FORMAT_LABELS } from '../format';
import { useSession } from '../session';

const STEPS = ['Informations', 'Format', 'Participants', 'Règles', 'Publication'];

/** « Prénom Nom / Prénom Nom ; niveau » → participant (une ligne par inscription). */
export function parseQuickList(text: string, mode: string, orderIsLevel: boolean) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    const [names, level] = line.split(';').map((s) => s.trim());
    const people = (mode === 'single' ? [names] : names.split('/')).map((p) => p.trim()).filter(Boolean);
    const members = people.map((p) => { const parts = p.split(/\s+/); return { firstName: parts.length > 1 ? parts[0] : '-', lastName: parts.length > 1 ? parts.slice(1).join(' ') : parts[0] }; });
    const rating = level && !Number.isNaN(Number(level.replace(',', '.'))) ? Number(level.replace(',', '.')) : orderIsLevel ? lines.length - i : undefined;
    return mode === 'team' ? { name: names, rating, members: [{ firstName: 'Capitaine', lastName: names, isCaptain: true }] } : { rating, members };
  });
}

export function Wizard() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const { me } = useSession();
  const orgId = q.get('org') ?? me?.organizations[0]?.id;
  const [catalog, setCatalog] = useState<any>(null);
  const [step, setStep] = useState(0);
  const today = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const [info, setInfo] = useState({ name: '', discipline: 'padel', date: today, start: '09:00', end: '19:00', venueName: '', maxParticipants: 16, mode: 'double', courts: 4, matchMinutes: 60, visibility: 'public' });
  const [format, setFormat] = useState<any>({ format: 'groups_knockout', formatConfig: { groups: { count: 4, distribution: 'snake', legs: 1, qualifiers: 2, avoidSameGroup: true }, knockout: { thirdPlace: false, seeding: 'seeded' } } });
  const [people, setPeople] = useState({ method: 'list', text: '', csv: '', orderIsLevel: true, requireApproval: false });
  const [rules, setRules] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const [progress, setProgress] = useState('');

  useEffect(() => { get('/api/catalog').then(setCatalog); }, []);
  const preset = catalog?.disciplines.find((d: any) => d.key === info.discipline);
  useEffect(() => {
    if (!preset) return;
    setInfo((i) => ({ ...i, mode: preset.defaultMode, matchMinutes: preset.matchMinutes }));
    setRules((r: any) => ({ ...(r ?? {}), scoring: preset.scoring, points: r?.points ?? { win: 3, draw: 1, loss: 0, forfeitLoss: 0 }, tiebreakers: r?.tiebreakers ?? ['points', 'head_to_head', 'set_diff', 'game_diff', 'games_won'], refereeMode: r?.refereeMode ?? 'none', confirmationHours: r?.confirmationHours ?? 2, autoConfirmOnTimeout: r?.autoConfirmOnTimeout ?? false }));
  }, [preset?.key]);

  const parsed = useMemo(() => (people.method === 'list' ? parseQuickList(people.text, info.mode, people.orderIsLevel) : []), [people, info.mode]);
  const count = people.method === 'list' ? parsed.length : people.method === 'csv' ? Math.max(0, people.csv.trim().split(/\r?\n/).length - 1) : 0;
  const suggest = () => get(`/api/catalog/suggest-format?participants=${info.maxParticipants}`).then(setFormat);
  const g = format.formatConfig.groups;
  const k = format.formatConfig.knockout ?? {};
  const setG = (patch: any) => setFormat({ ...format, formatConfig: { ...format.formatConfig, groups: { ...g, ...patch } } });
  const setK = (patch: any) => setFormat({ ...format, formatConfig: { ...format.formatConfig, knockout: { ...k, ...patch } } });

  const summary = () => {
    const n = count || info.maxParticipants;
    if (format.format === 'league') return `Championnat : ${n} participants, ${(n * (n - 1)) / 2 * (format.formatConfig.league?.legs ?? 1)} rencontres.`;
    if (format.format === 'knockout') { let s = 2; while (s < n) s *= 2; return `Tableau de ${s} : ${s - n} exemption(s), ${n - 1}${k.thirdPlace ? ' + 1' : ''} rencontres.`; }
    const per = Math.floor(n / g.count), extra = n % g.count;
    const base = `${g.count} poules de ${per}${extra ? ` à ${per + 1}` : ''}`;
    if (format.format === 'groups') return `${base}.`;
    const qn = g.qualifiers * g.count; let s = 2; while (s < qn) s *= 2;
    return `${base}, ${g.qualifiers} qualifié(s) par poule → tableau final de ${qn}${s > qn ? ` (${s - qn} exemption(s))` : ''}.`;
  };

  const iso = (d: string, t: string) => new Date(`${d}T${t}:00`).toISOString();
  const create = (generate: boolean) => run(async () => {
    setProgress('Création du tournoi…');
    const t = await post('/api/tournaments', {
      orgId, name: info.name, discipline: info.discipline, startsAt: iso(info.date, info.start), endsAt: iso(info.date, info.end), venueName: info.venueName || undefined,
      maxParticipants: Number(info.maxParticipants), mode: info.mode, courts: Number(info.courts), matchMinutes: Number(info.matchMinutes), visibility: info.visibility,
      format: format.format, formatConfig: format.formatConfig, scoring: rules.scoring, rankingRules: { points: rules.points, tiebreakers: rules.tiebreakers },
      refereeMode: rules.refereeMode, confirmationHours: Number(rules.confirmationHours), autoConfirmOnTimeout: rules.autoConfirmOnTimeout,
      registration: { open: people.method === 'self' || !generate, requireApproval: people.requireApproval },
    });
    if (people.method === 'list') {
      for (let i = 0; i < parsed.length; i++) { setProgress(`Inscription des participants ${i + 1}/${parsed.length}…`); await post(`/api/tournaments/${t.id}/participants`, parsed[i]); }
    } else if (people.method === 'csv' && people.csv.trim()) {
      setProgress('Import du fichier…');
      await post(`/api/tournaments/${t.id}/participants/import`, { csv: people.csv });
    }
    setProgress('Publication…');
    await post(`/api/tournaments/${t.id}/publish`, {});
    if (generate) { setProgress('Génération des rencontres…'); await post(`/api/tournaments/${t.id}/generate`, {}); }
    nav(`/t/${t.id}`);
  }).finally(() => setProgress(''));

  const next = () => {
    setError(null);
    if (step === 0 && info.name.trim().length < 2) return setError(new Error('Donnez un nom au tournoi.'));
    if (step === 1 && (format.format === 'groups' || format.format === 'groups_knockout') && (!g?.count || g.count < 1)) return setError(new Error('Nombre de poules requis.'));
    setStep(step + 1);
  };
  if (!orgId) return <div className="alert warn">Créez d’abord l’espace de votre club depuis « Compte ».</div>;
  if (!catalog || !rules) return null;

  return (
    <div className="narrow">
      <h1>Nouveau tournoi</h1>
      <ol className="stepper" aria-label="Étapes">{STEPS.map((s, i) => <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>

      {step === 0 && (
        <section className="card form">
          <label>Nom du tournoi<input autoFocus required value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} placeholder="Open de printemps" /></label>
          <label>Discipline<select value={info.discipline} onChange={(e) => setInfo({ ...info, discipline: e.target.value })}>{catalog.disciplines.map((d: any) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
          <div className="grid3">
            <label>Date<input type="date" value={info.date} onChange={(e) => setInfo({ ...info, date: e.target.value })} /></label>
            <label>Début<input type="time" value={info.start} onChange={(e) => setInfo({ ...info, start: e.target.value })} /></label>
            <label>Fin<input type="time" value={info.end} onChange={(e) => setInfo({ ...info, end: e.target.value })} /></label>
          </div>
          <label>Lieu<input value={info.venueName} onChange={(e) => setInfo({ ...info, venueName: e.target.value })} placeholder="Complexe sportif…" /></label>
          <div className="grid3">
            <label>Participants max<input type="number" min={2} max={2000} value={info.maxParticipants} onChange={(e) => setInfo({ ...info, maxParticipants: Number(e.target.value) })} /></label>
            <label>Terrains<input type="number" min={1} max={200} value={info.courts} onChange={(e) => setInfo({ ...info, courts: Number(e.target.value) })} /></label>
            <label>Durée d’un match (min)<input type="number" min={5} max={600} value={info.matchMinutes} onChange={(e) => setInfo({ ...info, matchMinutes: Number(e.target.value) })} /></label>
          </div>
          <fieldset><legend>Mode</legend>{(['single', 'double', 'team'] as const).map((m) => <label key={m} className="check"><input type="radio" name="mode" checked={info.mode === m} onChange={() => setInfo({ ...info, mode: m })} /> {({ single: 'Individuel', double: 'Double', team: 'Équipes' })[m]}</label>)}</fieldset>
          <fieldset><legend>Accès</legend>
            <label className="check"><input type="radio" name="vis" checked={info.visibility === 'public'} onChange={() => setInfo({ ...info, visibility: 'public' })} /> Public : résultats consultables par tous</label>
            <label className="check"><input type="radio" name="vis" checked={info.visibility === 'private'} onChange={() => setInfo({ ...info, visibility: 'private' })} /> Privé : participants uniquement</label>
          </fieldset>
        </section>
      )}

      {step === 1 && (
        <section className="card form">
          <div className="choices">
            {Object.entries(FORMAT_LABELS).map(([key, label]) => (
              <button key={key} type="button" className={`choice ${format.format === key ? 'active' : ''}`} aria-pressed={format.format === key}
                onClick={() => setFormat({ format: key, formatConfig: { ...format.formatConfig, groups: format.formatConfig.groups ?? { count: 2, distribution: 'snake', legs: 1, qualifiers: 2, avoidSameGroup: true }, league: { legs: 1 }, knockout: format.formatConfig.knockout ?? { thirdPlace: false, seeding: 'seeded' } } })}>
                {label}{key === 'groups_knockout' && <small>recommandé padel</small>}
              </button>
            ))}
          </div>
          <button type="button" className="link" onClick={suggest}>Suggérer un format pour {info.maxParticipants} participants</button>
          {(format.format === 'groups' || format.format === 'groups_knockout') && g && (
            <div className="grid3">
              <label>Nombre de poules<input type="number" min={1} max={64} value={g.count} onChange={(e) => setG({ count: Number(e.target.value) })} /></label>
              {format.format === 'groups_knockout' && <label>Qualifiés par poule<input type="number" min={1} max={16} value={g.qualifiers} onChange={(e) => setG({ qualifiers: Number(e.target.value) })} /></label>}
              <label>Répartition<select value={g.distribution} onChange={(e) => setG({ distribution: e.target.value })}><option value="snake">Par niveau (serpentin)</option><option value="seeded">Têtes de série + tirage</option><option value="random">Tirage au sort</option></select></label>
              <label>Rencontres<select value={g.legs} onChange={(e) => setG({ legs: Number(e.target.value) })}><option value={1}>Aller simple</option><option value={2}>Aller-retour</option></select></label>
            </div>
          )}
          {format.format === 'league' && <label>Rencontres<select value={format.formatConfig.league?.legs ?? 1} onChange={(e) => setFormat({ ...format, formatConfig: { ...format.formatConfig, league: { legs: Number(e.target.value) } } })}><option value={1}>Aller simple</option><option value={2}>Aller-retour</option></select></label>}
          {(format.format === 'knockout' || format.format === 'groups_knockout') && (
            <div className="grid2">
              <label className="check"><input type="checkbox" checked={!!k.thirdPlace} onChange={(e) => setK({ thirdPlace: e.target.checked })} /> Petite finale (3e place)</label>
              {format.format === 'knockout' && <label>Placement<select value={k.seeding ?? 'seeded'} onChange={(e) => setK({ seeding: e.target.value })}><option value="seeded">Têtes de série (niveau)</option><option value="random">Tirage au sort</option></select></label>}
              {format.format === 'groups_knockout' && <label className="check"><input type="checkbox" checked={g?.avoidSameGroup !== false} onChange={(e) => setG({ avoidSameGroup: e.target.checked })} /> Éviter les revanches de poule</label>}
            </div>
          )}
          <p className="alert info">{summary()}</p>
        </section>
      )}

      {step === 2 && (
        <section className="card form">
          <fieldset><legend>Ajouter les participants</legend>
            {[['list', 'Saisie rapide (une ligne par inscription)'], ['csv', 'Fichier CSV / Excel (enregistré en CSV)'], ['self', 'Inscription autonome des joueurs par lien et QR Code']].map(([v, l]) => (
              <label key={v} className="check"><input type="radio" name="method" checked={people.method === v} onChange={() => setPeople({ ...people, method: v })} /> {l}</label>
            ))}
          </fieldset>
          {people.method === 'list' && (
            <>
              <label>{info.mode === 'double' ? 'Une paire par ligne : « Prénom Nom / Prénom Nom ; niveau »' : info.mode === 'team' ? 'Un nom d’équipe par ligne' : 'Un joueur par ligne : « Prénom Nom ; niveau »'}
                <textarea rows={10} value={people.text} onChange={(e) => setPeople({ ...people, text: e.target.value })} placeholder={info.mode === 'double' ? 'Léa Martin / Hugo Bernard\nInès Petit / Tom Durand' : 'Léa Martin\nHugo Bernard'} /></label>
              <label className="check"><input type="checkbox" checked={people.orderIsLevel} onChange={(e) => setPeople({ ...people, orderIsLevel: e.target.checked })} /> L’ordre de la liste correspond au niveau (têtes de série)</label>
              <p className="muted">{parsed.length} inscription(s) reconnue(s).</p>
            </>
          )}
          {people.method === 'csv' && (
            <>
              <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPeople({ ...people, csv: await f.text() }); }} />
              <p className="muted small">Colonnes reconnues : Nom, Prénom, Email, Téléphone, Club, Niveau, Catégorie, Équipe (et Nom2, Prénom2 pour le partenaire de double). Depuis Excel : « Enregistrer sous… CSV ».</p>
              {people.csv && <p>{count} ligne(s) détectée(s).</p>}
            </>
          )}
          {people.method === 'self' && (
            <>
              <p>Après publication, vous obtiendrez un lien et un QR Code d’inscription à diffuser. Vous générerez les rencontres une fois les inscriptions closes.</p>
              <label className="check"><input type="checkbox" checked={people.requireApproval} onChange={(e) => setPeople({ ...people, requireApproval: e.target.checked })} /> Valider chaque inscription manuellement</label>
            </>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="card form">
          <h2>Score</h2>
          {rules.scoring.mode === 'sets' ? (
            <div className="grid3">
              <label>Sets gagnants<select value={rules.scoring.setsToWin} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, setsToWin: Number(e.target.value) } })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} (au meilleur des {2 * n - 1})</option>)}</select></label>
              <label>{rules.scoring.set.kind === 'games' ? 'Jeux par set' : 'Points par manche'}<input type="number" min={1} max={100} value={rules.scoring.set.target} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, set: { ...rules.scoring.set, target: Number(e.target.value) } } })} /></label>
              {rules.scoring.set.kind === 'games' && <label className="check"><input type="checkbox" checked={rules.scoring.set.tiebreak !== false} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, set: { ...rules.scoring.set, tiebreak: e.target.checked } } })} /> Tie-break</label>}
              <label className="check"><input type="checkbox" checked={!!rules.scoring.superTiebreak} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, superTiebreak: e.target.checked } })} /> Super tie-break au set décisif</label>
            </div>
          ) : (
            <div className="grid2">
              <label className="check"><input type="checkbox" checked={!!rules.scoring.drawAllowed} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, drawAllowed: e.target.checked } })} /> Match nul autorisé (hors tableau)</label>
              <label>Score à atteindre <small className="muted">(vide = libre)</small><input type="number" value={rules.scoring.pointsTarget ?? ''} onChange={(e) => setRules({ ...rules, scoring: { ...rules.scoring, pointsTarget: e.target.value ? Number(e.target.value) : undefined } })} /></label>
            </div>
          )}
          <h2>Classement</h2>
          <div className="grid4">
            {(['win', 'draw', 'loss', 'forfeitLoss'] as const).map((key) => (
              <label key={key}>{({ win: 'Victoire', draw: 'Nul', loss: 'Défaite', forfeitLoss: 'Forfait' })[key]}<input type="number" value={rules.points[key]} onChange={(e) => setRules({ ...rules, points: { ...rules.points, [key]: Number(e.target.value) } })} /></label>
            ))}
          </div>
          <p>Départage, dans l’ordre :</p>
          <ol className="reorder">
            {rules.tiebreakers.map((tb: string, i: number) => (
              <li key={tb}>{catalog.tiebreakers.find((x: any) => x.key === tb)?.label}
                <span>
                  <button type="button" className="icon" aria-label="Monter" disabled={i === 0} onClick={() => { const a = [...rules.tiebreakers]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setRules({ ...rules, tiebreakers: a }); }}>↑</button>
                  <button type="button" className="icon" aria-label="Retirer" onClick={() => setRules({ ...rules, tiebreakers: rules.tiebreakers.filter((x: string) => x !== tb) })}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          <select value="" onChange={(e) => e.target.value && setRules({ ...rules, tiebreakers: [...rules.tiebreakers, e.target.value] })} aria-label="Ajouter un critère">
            <option value="">+ Ajouter un critère</option>
            {catalog.tiebreakers.filter((x: any) => !rules.tiebreakers.includes(x.key)).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <h2>Validation des scores</h2>
          <label>Arbitrage<select value={rules.refereeMode} onChange={(e) => setRules({ ...rules, refereeMode: e.target.value })}>
            <option value="none">Sans arbitre : les joueurs saisissent, l’adversaire confirme</option><option value="optional">Arbitres sur certaines rencontres</option><option value="required">Arbitre obligatoire</option></select></label>
          <div className="grid2">
            <label>Délai de confirmation (heures)<input type="number" min={0} max={168} value={rules.confirmationHours} onChange={(e) => setRules({ ...rules, confirmationHours: Number(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={rules.autoConfirmOnTimeout} onChange={(e) => setRules({ ...rules, autoConfirmOnTimeout: e.target.checked })} /> Valider automatiquement à l’expiration du délai</label>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="card">
          <h2>{info.name}</h2>
          <ul>
            <li>{preset?.label} · {({ single: 'individuel', double: 'double', team: 'équipes' } as any)[info.mode]} · {info.courts} terrain(s) · matchs de {info.matchMinutes} min</li>
            <li>{FORMAT_LABELS[format.format]} — {summary()}</li>
            <li>{people.method === 'self' ? 'Inscriptions par QR Code' : `${count} participant(s)`}</li>
            <li>{info.visibility === 'public' ? 'Résultats publics' : 'Tournoi privé'}</li>
          </ul>
          {progress && <p aria-live="polite" className="muted">{progress}</p>}
          <ErrorBox error={error} />
          <div className="stack">
            {people.method !== 'self' && count >= 2 && <button className="primary block" disabled={busy} onClick={() => void create(true)}>Créer, générer les rencontres et publier</button>}
            <button className={people.method === 'self' || count < 2 ? 'primary block' : 'secondary block'} disabled={busy} onClick={() => void create(false)}>Créer et ouvrir les inscriptions</button>
          </div>
        </section>
      )}

      {step < 4 && <ErrorBox error={error} />}
      <div className="row between wizard-nav">
        <button className="secondary" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Retour</button>
        {step < 4 && <button className="primary" onClick={next}>Continuer</button>}
      </div>
    </div>
  );
}
