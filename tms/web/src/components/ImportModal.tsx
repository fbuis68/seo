import { useState } from 'react';
import { ImportBatches } from './ImportBatches';
import { ImportWizard } from './ImportWizard';

/** Import depuis l'écran Clients ou Apprenants : assistant Excel/CSV et lots précédents. */
export function ImportModal({ title, entity, onClose, onDone }: { title: string; entity: 'client' | 'person'; onClose: () => void; onDone: () => void }) {
  const [resume, setResume] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  return (
    <div className="pl-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="panel stack" style={{ maxWidth: 1000 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost sm" onClick={onClose}>Fermer</button></div>
        <ImportWizard simple defaultEntity={entity} resumeId={resume} onResumed={() => setResume(null)} onPublished={() => { setTick(tick + 1); onDone(); }} />
        <ImportBatches reloadKey={tick} onChange={onDone} onResume={setResume} />
      </div>
    </div>
  );
}
