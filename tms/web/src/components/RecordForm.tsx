import { useState } from 'react';

export type FieldDef = {
  key: string; label: string; required?: boolean; full?: boolean; hint?: string;
  type?: 'text' | 'email' | 'date' | 'number' | 'textarea' | 'select' | 'checkbox' | 'multi' | 'address' | 'url';
  options?: [string, string][];
};

/** Fenêtre de création / modification générique : champs décrits, enregistrement par `onSave`. */
export function RecordForm({ title, fields, initial, onSave, onClose, saveLabel = 'Enregistrer' }: {
  title: string; fields: FieldDef[]; initial: Record<string, any>; onSave: (v: Record<string, any>) => Promise<unknown>; onClose: () => void; saveLabel?: string;
}) {
  const [v, setV] = useState<Record<string, any>>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: any) => setV((o) => ({ ...o, [k]: x }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await onSave(v); onClose(); } catch (x: any) { setErr(x.message ?? 'Erreur'); } finally { setBusy(false); }
  };
  const input = (f: FieldDef) => {
    const val = v[f.key];
    switch (f.type) {
      case 'textarea': return <textarea rows={3} required={f.required} value={val ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
      case 'select': return <select required={f.required} value={val ?? ''} onChange={(e) => set(f.key, e.target.value)}>{!f.required && <option value="">—</option>}{f.options?.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
      case 'checkbox': return <input type="checkbox" checked={!!val} onChange={(e) => set(f.key, e.target.checked)} />;
      case 'multi': return <span className="row" style={{ flexWrap: 'wrap', gap: 10 }}>{f.options?.map(([k, l]) => (
        <label key={k} className="row small"><input type="checkbox" checked={(val ?? []).includes(k)} onChange={(e) => set(f.key, e.target.checked ? [...(val ?? []), k] : (val ?? []).filter((x: string) => x !== k))} />{l}</label>))}</span>;
      case 'address': {
        const a = val ?? {};
        const sa = (k: string, x: string) => set(f.key, { ...a, [k]: x });
        return <span className="grid2">
          <input placeholder="Adresse" aria-label="Adresse" value={a.line1 ?? ''} onChange={(e) => sa('line1', e.target.value)} />
          <input placeholder="Complément" aria-label="Complément d’adresse" value={a.line2 ?? ''} onChange={(e) => sa('line2', e.target.value)} />
          <input placeholder="Code postal" aria-label="Code postal" value={a.postal_code ?? ''} onChange={(e) => sa('postal_code', e.target.value)} />
          <input placeholder="Ville" aria-label="Ville" value={a.city ?? ''} onChange={(e) => sa('city', e.target.value)} />
          <input placeholder="Pays (FR)" aria-label="Pays" value={a.country ?? ''} onChange={(e) => sa('country', e.target.value)} />
        </span>;
      }
      default: return <input type={f.type ?? 'text'} required={f.required} step={f.type === 'number' ? 'any' : undefined} value={val ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };
  return (
    <div className="pl-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <form className="panel stack" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <div className="grid2">
          {fields.map((f) => (
            <label key={f.key} style={f.full || f.type === 'address' || f.type === 'textarea' || f.type === 'multi' ? { gridColumn: '1 / -1' } : undefined} className={f.type === 'checkbox' ? 'row' : undefined}>
              {f.type === 'checkbox' ? <>{input(f)} {f.label}</> : <>{f.label}{f.required && ' *'}{input(f)}</>}
              {f.hint && <span className="small muted">{f.hint}</span>}
            </label>))}
        </div>
        {err && <p className="alert" role="alert">{err}</p>}
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="btn" disabled={busy}>{saveLabel}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Fermer</button>
        </div>
      </form>
    </div>
  );
}

/** Valeurs de formulaire → corps d'API : chaînes vides envoyées à null (champ effacé). */
export const clean = (v: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, typeof v[k] === 'string' ? (v[k].trim() === '' ? null : v[k].trim()) : v[k] ?? null]));
