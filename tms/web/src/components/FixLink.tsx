import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Correction proposée pour un message d'alerte : écran à ouvrir (`to`, peut finir par #fix=<ancre>) et/ou élément de la page (`anchor`). */
export interface Fix { label?: string; to?: string; anchor?: string }
export interface Alert { message: string; fix?: Fix | null }

/** Amène l'utilisateur sur l'élément : ouvre un <details>, fait défiler, met en évidence et donne le focus (clic si c'est un bouton d'action). */
export function focusAnchor(id: string, tries = 10) {
  const el = document.getElementById(id);
  if (!el) { if (tries > 0) setTimeout(() => focusAnchor(id, tries - 1), 150); return; }
  if (el.tagName === 'BUTTON' && el.dataset.fixClick !== undefined) { el.click(); return; }
  let p: HTMLElement | null = el;
  while (p) { if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true; p = p.parentElement; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('fix-flash');
  setTimeout(() => el.classList.remove('fix-flash'), 2200);
  const f = el.matches('input,select,textarea,button,a') ? el
    : el.querySelector<HTMLElement>('input,select,textarea,button') ?? el.closest('form')?.querySelector<HTMLElement>('input,select,textarea');
  f?.focus({ preventScroll: true });
}

/** Bouton « Corriger » d'un message d'alerte. */
export function FixLink({ fix, children }: { fix?: Fix | null; children?: React.ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  if (!fix || (!fix.to && !fix.anchor)) return null;
  const go = () => {
    if (fix.to) {
      const [path, hash] = fix.to.split('#');
      if (path && path !== loc.pathname + loc.search) { nav(fix.to); return; }
      if (hash?.startsWith('fix=')) focusAnchor(hash.slice(4));
    }
    if (fix.anchor) focusAnchor(fix.anchor);
  };
  return <button type="button" className="fix-link" onClick={go}>{children ?? fix.label ?? 'Corriger'} →</button>;
}

/** Liste de messages d'alerte avec, pour chacun, son bouton « Corriger ». */
export function AlertList({ items }: { items: Alert[] }) {
  return <ul className="alert-list">{items.map((a, i) => <li key={i}><span>{a.message}</span> <FixLink fix={a.fix} /></li>)}</ul>;
}

/** À l'arrivée sur une page via un lien « …#fix=<ancre> » : amène sur l'élément une fois la page chargée. */
export function useFixAnchor(ready: boolean) {
  const loc = useLocation();
  useEffect(() => {
    if (!ready || !loc.hash.startsWith('#fix=')) return;
    focusAnchor(decodeURIComponent(loc.hash.slice(5)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loc.key]);
}
