import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ImportBatches } from './ImportBatches';
import { QuickImport } from './QuickImport';

/** Import depuis l'écran Clients ou Apprenants : import rapide, puis imports précédents (annulables). */
export function ImportModal({ title, entity, role, onClose, onDone }: { title: string; entity: 'client' | 'person'; role?: 'learner' | 'trainer' | 'contact'; onClose: () => void; onDone: () => void }) {
  const [tick, setTick] = useState(0);
  return (
    <div className="pl-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="panel stack" style={{ maxWidth: 980 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost sm" onClick={onClose}>Fermer</button></div>
        <QuickImport entity={entity} role={role} onDone={() => { setTick(tick + 1); onDone(); }} onCancel={onClose} />
        <ImportBatches reloadKey={tick} onChange={onDone} onResume={() => { location.href = '/settings/reprise'; }} />
        <p className="small muted" style={{ margin: 0 }}>Plusieurs fichiers, sessions, factures ou sauvegarde d’un autre logiciel : <Link to="/settings/reprise" onClick={onClose}>reprise avancée</Link>.</p>
      </div>
    </div>
  );
}
