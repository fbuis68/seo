import { useEffect, useState } from 'react';
import { api } from '../api';
import { Branding, applyBranding, contrast, prepareLogo } from '../branding';
import { useApp } from '../context';
import { Help } from '../help';

const DEFAULTS = { accent: '#2457d6', sidebar: '#ffffff', doc: '#14161a' };

/** Réglages → Apparence : logo (interface et documents) et préférences de couleurs. */
export default function Appearance() {
  const { branding, setBranding, org } = useApp();
  const [f, setF] = useState({ accent: '', sidebar: '', doc: '', theme: 'auto' as Branding['theme'] });
  const [logo, setLogo] = useState<{ png: string; jpeg: string; previewUrl: string } | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (branding) setF({ accent: branding.accentColor ?? '', sidebar: branding.sidebarColor ?? '', doc: branding.docColor ?? '', theme: branding.theme }); }, [branding]);

  // Aperçu immédiat dans toute l'interface ; « Annuler » rétablit l'enregistré.
  const preview = (n: typeof f) => { setF(n); applyBranding({ ...(branding as Branding), accentColor: n.accent || null, sidebarColor: n.sidebar || null, docColor: n.doc || null, theme: n.theme }); };
  const run = async (fn: () => Promise<Branding>, ok: string) => {
    setBusy(true); setMsg({});
    try { setBranding(await fn()); setMsg({ ok }); } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); }
  };
  const lowContrast = f.accent && contrast(f.accent, '#ffffff') < 4.5;
  const docLow = f.doc && contrast(f.doc, '#ffffff') < 4.5;

  return (
    <div className="panel" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
      <div><strong>Apparence et logo</strong> <Help k="reglages.apparence" /></div>
      <div className="grid2">
        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <span className="small" style={{ fontWeight: 600 }}>Logo</span>
          <div className="logo-box">{logo ? <img src={logo.previewUrl} alt="Aperçu du nouveau logo" /> : branding?.logoUrl ? <img src={branding.logoUrl} alt={`Logo ${org.legal_name}`} /> : <span className="muted small">Aucun logo</span>}</div>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" aria-label="Choisir un logo"
            onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; setMsg({}); try { setLogo(await prepareLogo(file)); } catch (err: any) { setMsg({ err: err.message }); } }} />
          <p className="small muted" style={{ margin: 0 }}>PNG à fond transparent conseillé, format horizontal. Redimensionné automatiquement ; repris en haut à droite de chaque document PDF (conventions, convocations, attestations, émargements, factures, planning).</p>
          <div className="toolbar">
            <button type="button" className="btn sm" disabled={!logo || busy} onClick={() => run(() => api('PUT', '/api/v1/organization/logo', { png: logo!.png, jpeg: logo!.jpeg }), 'Logo enregistré.').then(() => setLogo(null))}>Enregistrer le logo</button>
            {logo && <button type="button" className="btn ghost sm" onClick={() => setLogo(null)}>Annuler</button>}
            {branding?.logoUrl && !logo && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => confirm('Retirer le logo de l’interface et des prochains documents ?') && run(() => api('DELETE', '/api/v1/organization/logo'), 'Logo retiré.')}>Retirer</button>}
          </div>
        </div>
        <form style={{ display: 'grid', gap: 8, alignContent: 'start' }} onSubmit={(e) => { e.preventDefault(); run(() => api('PUT', '/api/v1/organization/branding', { accentColor: f.accent || null, sidebarColor: f.sidebar || null, docColor: f.doc || null, theme: f.theme }), 'Couleurs enregistrées.'); }}>
          <Color label="Couleur principale (boutons, liens, sélection)" value={f.accent} def={DEFAULTS.accent} onChange={(v) => preview({ ...f, accent: v })} />
          {lowContrast && <span className="small" style={{ color: 'var(--warn)' }}>Contraste faible avec le texte blanc des boutons : choisissez une teinte plus foncée.</span>}
          <Color label="Fond du menu latéral" value={f.sidebar} def={DEFAULTS.sidebar} onChange={(v) => preview({ ...f, sidebar: v })} hint="Le texte passe en blanc ou en noir selon le fond." />
          <Color label="Couleur des titres des documents PDF" value={f.doc} def={DEFAULTS.doc} onChange={(v) => preview({ ...f, doc: v })} />
          {docLow && <span className="small" style={{ color: 'var(--warn)' }}>Couleur trop claire pour être lisible sur papier blanc.</span>}
          <label>Thème<select value={f.theme} onChange={(e) => preview({ ...f, theme: e.target.value as Branding['theme'] })}>
            <option value="auto">Automatique (selon l’ordinateur)</option><option value="light">Clair</option><option value="dark">Sombre</option></select></label>
          <div className="toolbar">
            <button className="btn sm" disabled={busy}>Enregistrer les couleurs</button>
            <button type="button" className="btn ghost sm" onClick={() => { applyBranding(branding); if (branding) setF({ accent: branding.accentColor ?? '', sidebar: branding.sidebarColor ?? '', doc: branding.docColor ?? '', theme: branding.theme }); }}>Annuler l’aperçu</button>
            <button type="button" className="btn ghost sm" onClick={() => preview({ accent: '', sidebar: '', doc: '', theme: 'auto' })}>Couleurs par défaut</button>
          </div>
        </form>
      </div>
      {msg.ok && <p className="success small" role="status">{msg.ok}</p>}
      {msg.err && <p className="alert small">{msg.err}</p>}
      <p className="small muted" style={{ margin: 0 }}>S’applique à tous les utilisateurs de l’organisme. Les documents déjà générés ne changent pas : regénérez-les pour y faire apparaître le nouveau logo.</p>
    </div>
  );
}

function Color({ label, value, def, onChange, hint }: { label: string; value: string; def: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <span className="small" style={{ fontWeight: 600 }}>{label}</span>
      <div className="toolbar" style={{ margin: '4px 0 0' }}>
        <input type="color" aria-label={label} value={value || def} onChange={(e) => onChange(e.target.value)} />
        <input aria-label={`${label} (code)`} size={8} value={value} placeholder="par défaut" onChange={(e) => { const v = e.target.value.trim(); if (!v || /^#[0-9a-fA-F]{6}$/.test(v)) onChange(v); }} />
        {value && <button type="button" className="linklike small" onClick={() => onChange('')}>par défaut</button>}
      </div>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}
