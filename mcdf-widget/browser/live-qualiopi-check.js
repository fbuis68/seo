/**
 * Script de decouverte pour le module Assistant Qualiopi.
 *
 * A coller dans la console du navigateur (F12), depuis un onglet deja
 * connecte a MCDF. Contrairement a live-reports.js (qui utilise des
 * entites deja confirmees), ce script teste des entites REPEREES DANS
 * LE CODE SOURCE mais jamais interrogees en direct :
 *   - sessionQualiopi
 *   - conventionExportQualiopi
 *   - fullConventionQualiopi
 *
 * Objectif : savoir si ces noms d'entite sont corrects, et si oui,
 * lister les champs qu'elles renvoient reellement (les noms de champs
 * imagines a partir du code source ne sont pas fiables tant qu'ils
 * n'ont pas ete vus dans une vraie reponse JSON).
 *
 * Copier le resultat de la console ici pour que le widget-qualiopi.html
 * soit adapte aux vrais champs.
 */
(async function () {
  const CANDIDATES = ['sessionQualiopi', 'conventionExportQualiopi', 'fullConventionQualiopi'];

  for (const entity of CANDIDATES) {
    console.log(`\n=== ${entity} ===`);
    try {
      const res = await fetch(`/wa/${entity}/list?nopaging=1&limit=5&_dc=${Date.now()}`, { credentials: 'same-origin' });
      if (res.status === 401 || res.status === 403) {
        console.log('-> Session non authentifiee (401/403).');
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.log('-> Reponse non-JSON (probablement une 404 ou une page HTML) : cette entite n\'existe probablement pas sous ce nom.');
        continue;
      }
      if (!data.success) {
        console.log('-> success:false ->', JSON.stringify(data).slice(0, 300));
        continue;
      }
      if (!data.root || data.root.length === 0) {
        console.log('-> Entite valide mais 0 resultat (rien a afficher ici, mais le nom est bon).');
        continue;
      }
      console.log(`-> OK, ${data.root.length} ligne(s) recue(s). Champs disponibles :`);
      console.log(Object.keys(data.root[0]));
      console.log('Premiere ligne complete :');
      console.log(data.root[0]);
    } catch (e) {
      console.log('-> Erreur reseau :', e.message);
    }
  }

  console.log('\n=== A copier-coller dans la conversation ===');
  console.log('Pour chaque entite ci-dessus : le nom, si elle repond, et la liste des champs.');
})();
