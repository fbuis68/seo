import { useEffect, useMemo, useState } from 'react';
import { HELP } from '../help';

/** Aide complète : toutes les fonctions, regroupées par domaine, avec recherche. */
export default function HelpPage() {
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const topics = useMemo(() => Object.entries(HELP).filter(([, t]) => !q || norm([t.title, t.intro, ...(t.points ?? []), t.tip ?? ''].join(' ')).includes(norm(q))), [q]);
  const sections = [...new Set(topics.map(([, t]) => t.section))];
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) setTimeout(() => { const el = document.getElementById(`aide-${id}`); el?.scrollIntoView({ block: 'start' }); el?.classList.add('help-hit'); }, 50);
  }, []);
  return (
    <>
      <h1>Aide</h1>
      <p className="muted">Grands principes de chaque fonction. Partout dans l’application, le bouton <span className="help-btn" aria-hidden>?</span> ouvre l’aide de la fonction concernée.</p>
      <div className="toolbar">
        <input type="search" aria-label="Rechercher dans l’aide" placeholder="Rechercher : dérogation, récurrence, quota…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
        {q && <span className="small muted">{topics.length} résultat(s)</span>}
      </div>
      <nav className="help-toc" aria-label="Sommaire de l’aide">
        {sections.map((s) => <div key={s}><strong className="small">{s}</strong>
          <ul>{topics.filter(([, t]) => t.section === s).map(([k, t]) => <li key={k}><a href={`#${k}`} onClick={(e) => { e.preventDefault(); history.replaceState(null, '', `#${k}`); document.getElementById(`aide-${k}`)?.scrollIntoView({ behavior: 'smooth' }); }}>{t.title}</a></li>)}</ul></div>)}
      </nav>
      {sections.map((s) => (
        <section key={s}>
          <h2>{s}</h2>
          {topics.filter(([, t]) => t.section === s).map(([k, t]) => (
            <article key={k} id={`aide-${k}`} className="panel help-article">
              <h3>{t.title}</h3>
              <p>{t.intro}</p>
              {t.points && <ul>{t.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              {t.tip && <p className="small"><strong>Astuce :</strong> {t.tip}</p>}
            </article>
          ))}
        </section>
      ))}
      {!topics.length && <p className="muted">Aucun sujet ne correspond.</p>}
    </>
  );
}
