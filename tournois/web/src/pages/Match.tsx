import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, patch, post } from '../api';
import { ErrorBox, Loading, Pill, ScoreForm, useAction } from '../components/ui';
import { fmtDateTime, scoreText, statusTone } from '../format';
import { useData, useLive } from '../session';

const ROLE: Record<string, string> = { home: 'Domicile', away: 'Extérieur', referee: 'Arbitre', organizer: 'Organisateur' };
const SUB: Record<string, string> = { pending: 'En attente', confirmed: 'Confirmée', disputed: 'Contestée', rejected: 'Rejetée', superseded: 'Remplacée', official: 'Officielle' };

export function MatchPage() {
  const { id } = useParams();
  const { data: d, error: loadError, reload } = useData<any>(`/api/matches/${id}`);
  useLive(d ? `/api/tournaments/${d.tournament.id}/stream` : null, reload);
  const { busy, error, run, setError } = useAction();
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState('');
  if (loadError) return <ErrorBox error={loadError} />;
  if (!d) return <Loading />;
  const m = d.match;
  const me = d.me;
  const closed = ['completed', 'walkover', 'bye', 'cancelled'].includes(m.status);
  const act = (fn: () => Promise<any>, msg: string) => run(async () => { await fn(); setDone(msg); setEditing(false); reload(); });

  /** Correction : si des rencontres suivantes sont jouées, l'organisateur confirme l'annulation en cascade. */
  const officialize = (score: any) => run(async () => {
    const reason = closed ? prompt('Motif de la correction (obligatoire)') : undefined;
    if (closed && !reason) return;
    try {
      await post(`/api/matches/${m.id}/validate-score`, { score, reason, version: m.version });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'downstream_played') {
        if (!confirm(`${e.message}\n\nConfirmer la correction et annuler les résultats dépendants ?`)) throw e;
        await post(`/api/matches/${m.id}/validate-score`, { score, reason, cascade: true });
      } else throw e;
    }
    setDone(closed ? 'Résultat corrigé : classements et tableau recalculés.' : 'Résultat validé.'); setEditing(false); reload();
  });

  const submit = (score: any) => (me.organizer ? officialize(score) : act(async () => {
    const r = await post(`/api/matches/${m.id}/scores`, { score, version: m.version });
    if (r.status === 'disputed') throw new ApiError(409, 'disputed', 'Votre saisie diffère de celle de l’adversaire : l’organisateur va trancher.');
  }, me.referee ? 'Score enregistré.' : 'Score envoyé : votre adversaire doit le confirmer.'));

  const pending = d.submissions.find((s: any) => s.status === 'pending');
  const disputed = d.submissions.filter((s: any) => s.status === 'disputed');
  return (
    <div className="narrow">
      <p><Link to={`/t/${d.tournament.id}?tab=matches`}>← {d.tournament.name}</Link></p>
      <section className={`card match-hero ${statusTone(m.status)}`}>
        <p className="muted">{m.roundLabel} · {m.key}</p>
        <div className="versus">
          <div className={m.winnerId && m.winnerId === m.home.id ? 'won' : ''}><strong>{m.home.name}</strong><small>{d.players.home.join(' · ')}</small></div>
          <div className="vs">{scoreText(m.score) || 'contre'}</div>
          <div className={m.winnerId && m.winnerId === m.away.id ? 'won' : ''}><strong>{m.away.name}</strong><small>{d.players.away.join(' · ')}</small></div>
        </div>
        <p><Pill tone={statusTone(m.status)}>{m.statusLabel}</Pill>{m.outcome === 'retired' && <Pill>Abandon</Pill>}</p>
        <p className="big">{m.court ? `Terrain ${m.court}` : 'Terrain à définir'} · {m.scheduledAt ? fmtDateTime(m.scheduledAt) : 'horaire à définir'}</p>
        {d.referee && <p>Arbitre : {d.referee}</p>}
      </section>

      {done && <div className="alert ok" role="status">{done}</div>}
      <ErrorBox error={error} />

      {me.canConfirm && pending && (
        <section className="card">
          <h2>Confirmez-vous ce score ?</h2>
          <p className="big">{scoreText(pending.score)}</p>
          <p className="muted">Saisi par {pending.submitted_by_name}{pending.expires_at ? ` · à confirmer avant ${fmtDateTime(pending.expires_at)}` : ''}</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void act(() => post(`/api/matches/${m.id}/confirm-score`, { submissionId: pending.id }), 'Score confirmé : le résultat est officiel.')}>Confirmer</button>
            <button className="danger" disabled={busy} onClick={() => { const reason = prompt('Pourquoi contestez-vous ce score ?'); if (reason) void act(() => post(`/api/matches/${m.id}/dispute-score`, { submissionId: pending.id, reason }), 'Contestation envoyée à l’organisateur.'); }}>Contester</button>
          </div>
        </section>
      )}

      {pending && !me.canConfirm && !me.organizer && pending.mine && <div className="alert info">Score envoyé ({scoreText(pending.score)}) : en attente de confirmation par l’adversaire. Vous pouvez le corriger en le saisissant de nouveau.</div>}

      {me.organizer && (pending || disputed.length > 0) && (
        <section className="card">
          <h2>{disputed.length ? 'Scores contradictoires : à trancher' : 'Score en attente'}</h2>
          {[...(pending ? [pending] : []), ...disputed].map((s: any) => (
            <div key={s.id} className="row between">
              <span>{ROLE[s.submitter_role]} ({s.submitted_by_name}) : <strong>{scoreText(s.score)}</strong>{s.reason && <small className="muted"> — {s.reason}</small>}</span>
              <button className="primary" disabled={busy} onClick={() => void act(() => post(`/api/matches/${m.id}/validate-score`, { submissionId: s.id }), 'Score validé.')}>Valider celui-ci</button>
            </div>
          ))}
        </section>
      )}

      {((me.canSubmit && !closed) || (me.organizer && closed && m.status !== 'bye' && editing)) && m.home.id && m.away.id && (
        <section className="card">
          <h2>{closed ? 'Corriger le résultat' : me.organizer ? 'Saisir le résultat (officiel)' : 'Saisir le score'}</h2>
          <ScoreForm scoring={d.tournament.scoring} homeName={m.home.name} awayName={m.away.name} initial={closed ? m.score : pending?.score} busy={busy}
            onSubmit={(s) => { setError(null); void submit(s); }} submitLabel={closed ? 'Corriger' : me.organizer ? 'Valider le résultat' : 'Envoyer à l’adversaire'} />
        </section>
      )}
      {me.organizer && closed && m.status !== 'bye' && !editing && <button className="secondary" onClick={() => setEditing(true)}>Corriger le résultat</button>}

      {(me.organizer || me.referee) && !closed && <MatchActions d={d} busy={busy} act={act} />}

      {d.submissions.length > 0 && (
        <section className="card">
          <h2>Saisies</h2>
          <ul className="list">{d.submissions.map((s: any) => (
            <li key={s.id}><strong>{scoreText(s.score)}</strong> · {ROLE[s.submitter_role]} ({s.submitted_by_name}) · {SUB[s.status]} <small className="muted">{new Date(s.created_at).toLocaleString('fr-FR')}{s.decided_by_name ? ` · décision : ${s.decided_by_name}` : ''}</small>{s.reason && <div className="small">{s.reason}</div>}</li>
          ))}</ul>
        </section>
      )}
      {d.history && d.history.length > 0 && (
        <section className="card">
          <h2>Historique</h2>
          <ul className="list">{d.history.map((h: any, i: number) => (
            <li key={i}><strong>{h.action}</strong> <small className="muted">{new Date(h.at).toLocaleString('fr-FR')} · {h.actor ?? 'système'}</small>
              {h.before?.score && <div className="small">Avant : {scoreText(h.before.score)}</div>}{h.after?.score && <div className="small">Après : {scoreText(h.after.score)}</div>}{h.reason && <div className="small">Motif : {h.reason}</div>}</li>
          ))}</ul>
        </section>
      )}
    </div>
  );
}

function MatchActions({ d, busy, act }: { d: any; busy: boolean; act: (fn: () => Promise<any>, msg: string) => any }) {
  const m = d.match;
  const [court, setCourt] = useState(m.court ?? '');
  const [at, setAt] = useState(m.scheduledAt ? new Date(new Date(m.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const status = (s: string, label: string, reason?: boolean) => () => {
    const r = reason ? prompt('Motif') : undefined;
    if (reason && !r) return;
    void act(() => post(`/api/matches/${m.id}/status`, { status: s, reason: r }), label);
  };
  return (
    <section className="card form">
      <h2>Gestion de la rencontre</h2>
      <div className="row wrap">
        {['scheduled', 'to_schedule', 'postponed'].includes(m.status) && <button className="secondary" disabled={busy} onClick={status('called', 'Joueurs convoqués.')}>Convoquer</button>}
        {['scheduled', 'called', 'to_schedule', 'postponed'].includes(m.status) && <button className="secondary" disabled={busy} onClick={status('in_progress', 'Rencontre commencée.')}>Démarrer</button>}
        {m.status !== 'postponed' && <button className="secondary" disabled={busy} onClick={status('postponed', 'Rencontre reportée.', true)}>Reporter</button>}
        {d.me.organizer && m.stageKind !== 'knockout' && <button className="danger" disabled={busy} onClick={status('cancelled', 'Rencontre annulée.', true)}>Annuler</button>}
      </div>
      {m.home.id && m.away.id && (
        <div className="row wrap">
          <span>Forfait :</span>
          {(['home', 'away'] as const).map((side) => (
            <button key={side} className="danger" disabled={busy} onClick={() => { const reason = prompt(`Motif du forfait de ${m[side].name}`); if (reason) void act(() => post(`/api/matches/${m.id}/walkover`, { loser: side, reason }), 'Forfait enregistré.'); }}>{m[side].name}</button>
          ))}
        </div>
      )}
      {d.me.organizer && (
        <div className="grid3">
          <label>Terrain<input type="number" min={1} value={court} onChange={(e) => setCourt(e.target.value)} /></label>
          <label>Horaire<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
          <button className="secondary" disabled={busy} onClick={() => void act(async () => {
            const r = await patch(`/api/matches/${m.id}/schedule`, { court: court ? Number(court) : null, scheduledAt: at ? new Date(at).toISOString() : null, locked: true, version: m.version });
            if (r.warnings.length) alert(r.warnings.join('\n'));
          }, 'Planification enregistrée, joueurs prévenus.')}>Planifier</button>
        </div>
      )}
    </section>
  );
}
