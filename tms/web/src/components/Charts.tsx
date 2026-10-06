import { useState } from 'react';

/** Graphiques SVG accessibles : légende, tableau alternatif, statut jamais porté par la couleur seule. */
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const fmt = (v: number, unit?: string) => (unit === 'currency' ? v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }) : v.toLocaleString('fr-FR'));

export function DataTable({ rows, unit }: { rows: { label: string; value: number }[]; unit?: string }) {
  return (
    <details><summary>Voir les données</summary>
      <table><thead><tr><th>Libellé</th><th className="num">Valeur</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{fmt(r.value, unit)}</td></tr>)}</tbody></table>
    </details>
  );
}

export function LineChart({ series, compare, unit, title, onPoint }: { series: { label: string; value: number }[]; compare?: { label: string; value: number }[]; unit?: string; title: string; onPoint?: (i: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 220, P = 36;
  const all = [...series, ...(compare ?? [])].map((p) => p.value);
  const max = Math.max(10, ...all), min = Math.min(0, ...all);
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, series.length - 1);
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const path = (s: { value: number }[]) => s.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title}>
        {[0, 0.5, 1].map((t) => { const v = min + t * (max - min); return <g key={t}><line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={4} y={y(v) + 4} fontSize="10" fill="var(--muted)">{fmt(Math.round(v), unit)}</text></g>; })}
        {compare && <path d={path(compare)} fill="none" stroke="var(--c6)" strokeWidth="2" strokeDasharray="5 4" />}
        <path d={path(series)} fill="none" stroke="var(--c1)" strokeWidth="2.5" />
        {series.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onPoint?.(i)} style={{ cursor: onPoint ? 'pointer' : 'default' }}>
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3.5} fill="var(--c1)" />
            <rect x={x(i) - 12} y={P} width={24} height={H - 2 * P} fill="transparent" />
            <text x={x(i)} y={H - 10} fontSize="10" textAnchor="middle" fill="var(--muted)">{p.label}</text>
          </g>
        ))}
        {hover != null && <text x={x(hover)} y={y(series[hover].value) - 10} fontSize="11" textAnchor="middle" fill="var(--fg)">{fmt(series[hover].value, unit)}</text>}
      </svg>
      <div className="legend"><span><i style={{ background: 'var(--c1)' }} />Période</span>{compare && <span><i style={{ background: 'var(--c6)' }} />N-1 (pointillés)</span>}</div>
      <DataTable rows={series} unit={unit} />
    </figure>
  );
}

export function PieChart({ rows, unit, title }: { rows: { label: string; value: number }[]; unit?: string; title: string }) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (!total) return <p className="muted">Aucune donnée sur la période.</p>;
  let acc = 0;
  const R = 80, C = 100;
  return (
    <figure style={{ margin: 0, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <svg viewBox="0 0 200 200" width="180" role="img" aria-label={title}>
        {rows.map((r, i) => {
          const a0 = (acc / total) * 2 * Math.PI; acc += r.value; const a1 = (acc / total) * 2 * Math.PI;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = (a: number) => `${C + R * Math.sin(a)},${C - R * Math.cos(a)}`;
          return rows.length === 1 ? <circle key={i} cx={C} cy={C} r={R} fill={COLORS[0]} /> : <path key={i} d={`M${C},${C} L${p(a0)} A${R},${R} 0 ${large} 1 ${p(a1)} Z`} fill={COLORS[i % COLORS.length]} stroke="var(--panel)" />;
        })}
      </svg>
      <div className="legend" style={{ flexDirection: 'column' }}>
        {rows.map((r, i) => <span key={r.label}><i style={{ background: COLORS[i % COLORS.length] }} />{r.label} — {fmt(r.value, unit)} ({Math.round((r.value / total) * 100)} %)</span>)}
      </div>
    </figure>
  );
}

/** Barres horizontales (gèrent les valeurs négatives : utilisées à la place d'un camembert trompeur). */
export function BarChart({ rows, unit, title }: { rows: { label: string; value: number }[]; unit?: string; title: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div role="img" aria-label={title} style={{ display: 'grid', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 110px', gap: 8, alignItems: 'center', fontSize: '.88rem' }}>
          <span>{r.label}</span>
          <div style={{ background: 'var(--line)', height: 10, borderRadius: 4, position: 'relative' }}>
            <div style={{ width: `${(Math.abs(r.value) / max) * 100}%`, height: '100%', borderRadius: 4, background: r.value < 0 ? 'var(--c2)' : 'var(--c1)' }} />
          </div>
          <span className="num" style={{ textAlign: 'right' }}>{r.value < 0 ? '− ' : ''}{fmt(Math.abs(r.value), unit)}</span>
        </div>
      ))}
    </div>
  );
}
