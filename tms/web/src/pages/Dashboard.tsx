import { useState } from 'react';
import { Link } from 'react-router-dom';
import { date, eur } from '../api';
import { BarChart, LineChart, PieChart } from '../components/Charts';
import { can, has, useApp } from '../context';
import { useFetch } from '../hooks';
import { SESSION_STATUS } from './Sessions';

export default function Dashboard() {
  const { org } = useApp();
  const y = new Date().getFullYear();
  const [compare, setCompare] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  const finance = can(org, 'finance.read');
  const dash = useFetch('/api/v1/analytics/dashboard');
  const rev = useFetch(finance ? `/api/v1/analytics/metrics?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31&granularity=month${compare ? '&compare=true' : ''}` : null, [compare]);
  const cash = useFetch(finance ? `/api/v1/analytics/metrics?metric=cash_in_ttc&from=${y}-01-01&to=${y}-12-31&granularity=month` : null);
  const byProg = useFetch(finance ? `/api/v1/analytics/breakdown?metric=revenue_net_ht&dimension=program&from=${y}-01-01&to=${y}-12-31` : null);
  const recv = useFetch(finance ? '/api/v1/analytics/receivables' : null);
  const detail = useFetch(drill ? `/api/v1/analytics/drilldown?metric=revenue_net_ht&from=${drill}&to=${new Date(new Date(drill).getFullYear(), new Date(drill).getMonth() + 1, 0).toISOString().slice(0, 10)}` : null, [drill]);
  const months = (s: any[]) => s.map((p) => ({ label: new Date(p.period).toLocaleDateString('fr-FR', { month: 'short' }), value: Number(p.value) }));
  const c = dash.data?.cards;
  return (
    <>
      <h1>Bonjour</h1>
      {c && (
        <div className="cards">
          <div className="panel card"><div className="label">Sessions à venir</div><div className="value">{c.upcomingSessions}</div></div>
          <div className="panel card"><div className="label">Apprenants {y}</div><div className="value">{c.learnersThisYear}</div></div>
          {finance && <div className="panel card"><div className="label">CA facturé net HT {y}</div><div className="value">{eur(c.revenueYtdHt)}</div></div>}
          {finance && <div className="panel card"><div className="label">Encaissements TTC {y}</div><div className="value">{eur(c.cashInYtdTtc)}</div></div>}
          {finance && <div className="panel card"><div className="label">Impayés échus TTC</div><div className="value" style={{ color: Number(c.overdueTtc) > 0 ? 'var(--err)' : undefined }}>{eur(c.overdueTtc)}</div></div>}
        </div>
      )}
      {c && c.upcoming.length === 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Démarrer</h2>
          <ol><li>Créez un programme et une session (<Link to="/sessions">Sessions</Link>)</li><li>Ajoutez vos apprenants (<Link to="/clients">Clients & apprenants</Link>)</li><li>Ou reprenez vos données existantes (<Link to="/imports">Reprise de données</Link>)</li></ol>
        </div>
      )}
      {finance && (
        <div className="grid2" style={{ marginTop: 16 }}>
          <div className="panel">
            <div className="toolbar" style={{ justifyContent: 'space-between' }}>
              <strong>CA facturé net HT — {y}</strong>
              {has(org, 'analytics.advanced') && <label className="row small"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />Comparer N-1</label>}
            </div>
            {rev.data && <LineChart title="CA facturé net HT par mois" unit="currency" series={months(rev.data.series)} compare={rev.data.previous ? months(rev.data.previous) : undefined} onPoint={(i) => setDrill(rev.data.series[i].period)} />}
            <p className="small muted" title={rev.data?.definition?.definition}>Définition v{rev.data?.definition?.version} : factures émises − avoirs, par date d’émission. Cliquez un point pour le détail.</p>
          </div>
          <div className="panel">
            <strong>Encaissements clients TTC — {y}</strong>
            {cash.data && <LineChart title="Encaissements TTC par mois" unit="currency" series={months(cash.data.series)} />}
          </div>
          <div className="panel">
            <strong>CA par programme</strong>
            {byProg.data && (byProg.data.chartHint === 'pie'
              ? <PieChart title="Répartition du CA par programme" unit="currency" rows={byProg.data.rows.map((r: any) => ({ label: r.label, value: Number(r.value) }))} />
              : <BarChart title="Répartition du CA par programme" unit="currency" rows={byProg.data.rows.map((r: any) => ({ label: r.label, value: Number(r.value) }))} />)}
          </div>
          <div className="panel">
            <strong>Balance âgée (TTC)</strong>
            {recv.data && <BarChart title="Impayés par ancienneté" unit="currency" rows={[['Non échu', 'not_due'], ['1–30 j', 'd1_30'], ['31–60 j', 'd31_60'], ['61–90 j', 'd61_90'], ['> 90 j', 'd90_plus']].map(([l, k]) => ({ label: l, value: Number(recv.data.buckets[k]) }))} />}
          </div>
        </div>
      )}
      {drill && detail.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="toolbar" style={{ justifyContent: 'space-between' }}><strong>Détail {new Date(drill).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</strong><button className="btn ghost sm" onClick={() => setDrill(null)}>Fermer</button></div>
          <table><thead><tr><th>Date</th><th>Pièce</th><th>Client</th><th>Programme</th><th className="num">HT</th></tr></thead>
            <tbody>{detail.data.rows.map((r: any) => <tr key={r.id}><td>{date(r.d)}</td><td>{r.number} {r.kind === 'credit_note' && <span className="pill warn">avoir</span>}</td><td>{r.client_name}</td><td>{r.program_title ?? 'Non affecté'}</td><td className="num">{eur(r.value)}</td></tr>)}</tbody></table>
        </div>
      )}
      {c && c.upcoming.length > 0 && (
        <>
          <h2>Prochaines sessions</h2>
          <div className="panel"><table><thead><tr><th>Session</th><th>Début</th><th>Statut</th><th className="num">Inscrits</th></tr></thead>
            <tbody>{c.upcoming.map((s: any) => <tr key={s.id}><td><Link to={`/sessions/${s.id}`}>{s.title}</Link></td><td>{date(s.starts_on)}</td><td>{SESSION_STATUS[s.status] ?? s.status}</td><td className="num">{s.enrolled}{s.capacity ? ` / ${s.capacity}` : ''}</td></tr>)}</tbody></table></div>
        </>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>Calculé le {dash.data ? new Date(dash.data.computedAt).toLocaleString('fr-FR') : '—'}</p>
    </>
  );
}
