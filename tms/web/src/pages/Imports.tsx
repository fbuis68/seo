import { useState } from 'react';
import { ImportBatches } from '../components/ImportBatches';
import { ImportWizard } from '../components/ImportWizard';
import { Help } from '../help';

/** Reprise de données : assistant complet (tous logiciels) et lots précédents (reprendre, relancer, supprimer). */
export default function Imports() {
  const [resume, setResume] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  return (
    <>
      <h1>Reprise de vos données <Help k="reprise" /></h1>
      <p className="muted">Reprise exclusivement à partir des fichiers de sauvegarde ou d’exports que vous déposez : aucun identifiant ni accès à votre ancien logiciel n’est demandé.</p>
      <div style={{ display: 'grid', gap: 12 }}>
        <ImportWizard resumeId={resume} onResumed={() => setResume(null)} onPublished={() => setTick(tick + 1)} />
        <ImportBatches reloadKey={tick} onResume={(id) => { setResume(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      </div>
    </>
  );
}
