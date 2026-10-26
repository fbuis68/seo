import { post } from '../api';
import { ImportWizard } from '../components/ImportWizard';
import { useAction, useFetch } from '../hooks';
import { Help } from '../help';

/** Reprise de données : assistant complet (tous logiciels) et lots précédents. */
export default function Imports() {
  const batches = useFetch<any[]>('/api/v1/imports');
  const act = useAction();
  return (
    <>
      <h1>Reprise de vos données <Help k="reprise" /></h1>
      <p className="muted">Reprise exclusivement à partir des fichiers de sauvegarde ou d’exports que vous déposez : aucun identifiant ni accès à votre ancien logiciel n’est demandé.</p>
      <div className="grid2">
        <ImportWizard onPublished={() => batches.reload()} />
        <div className="panel">
          <strong>Lots précédents</strong>
          <table><tbody>{batches.data?.map((b) => <tr key={b.id}><td>{b.source_software}</td><td>{b.status}</td><td>{new Date(b.created_at).toLocaleDateString('fr-FR')}</td>
            <td>{b.status === 'published' && <button className="btn ghost sm" onClick={() => confirm('Annuler ce lot (compensation) ?') && act.run(() => post(`/api/v1/imports/${b.id}/rollback`), () => batches.reload())}>Annuler le lot</button>}
              {['uploaded', 'detected', 'mapped', 'simulated', 'rejected'].includes(b.status) && <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/imports/${b.id}/cancel`), () => batches.reload())}>Abandonner</button>}</td></tr>)}</tbody></table>
          {act.error && <p className="alert small">{act.error}</p>}
        </div>
      </div>
    </>
  );
}
