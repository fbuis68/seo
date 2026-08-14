/**
 * Restitutions MCDF calculées en direct sur les données réelles.
 *
 * À coller dans la console du navigateur (F12) pendant que vous êtes
 * connecté à https://portal.moncentredeformation.fr — réutilise le cookie
 * de session déjà actif, aucune identification supplémentaire nécessaire.
 *
 * Entités et champs confirmés par capture réseau réelle (voir
 * mcdf-widget/client/mcdf_client.py pour le détail de la découverte) :
 *   - customer          : clients payeurs (created, prospect, status...)
 *   - convention        : devis ET dossiers (isProposal/isConvention,
 *                         proposalStatus, provisionalDate, signingDate)
 *   - invoice           : factures (amount, ttcAmount, billingDate)
 *   - conventionAttendee: jonction stagiaire<->convention (created,
 *                         fullname, attendeeId, conventionId, attendee)
 *   - session           : occurrences de formation (numberMini/Maxi,
 *                         trainerId/trainerName, dailyRate, days) — champs
 *                         de capacité absents sur certains anciens
 *                         enregistrements non liés à un catalogue.
 *
 * Limites connues (approximations à affiner) :
 *   - Le remplissage utilise numberMaxi comme proxy de capacité, sans
 *     compter précisément les inscrits par session (nécessiterait
 *     l'entité de jonction convention<->session, non encore explorée).
 *   - Le CA par formateur est estimé via dailyRate*days sur les sessions
 *     qui lui sont assignées (trainerId), pas via les factures réelles
 *     (qui ne portent pas de trainerId direct).
 */
(async function mcdfLiveReports() {
  async function fetchAll(entity) {
    const res = await fetch(`/wa/${entity}/list?nopaging=1&_dc=${Date.now()}`);
    const data = await res.json();
    if (!data.success) {
      throw new Error(`${entity}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.root;
  }

  const monthKey = (iso) => (iso ? iso.slice(0, 7) : null);
  const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null);

  console.log('Chargement des entités MCDF...');
  const [customers, conventions, invoices, attendees, sessions] = await Promise.all([
    fetchAll('customer'),
    fetchAll('convention'),
    fetchAll('invoice'),
    fetchAll('conventionAttendee'),
    fetchAll('session'),
  ]);
  console.log(
    `Chargé : ${customers.length} clients, ${conventions.length} conventions, `
    + `${invoices.length} factures, ${attendees.length} lignes stagiaire, `
    + `${sessions.length} sessions.`
  );

  // -------------------------------------------------------------------
  // 1. % de nouveaux clients par mois
  // -------------------------------------------------------------------
  const nouveauxParMois = {};
  customers.forEach((c) => {
    const m = monthKey(c.created);
    if (m) nouveauxParMois[m] = (nouveauxParMois[m] || 0) + 1;
  });
  console.log('--- 1. Nouveaux clients par mois ---');
  console.table(nouveauxParMois);

  // -------------------------------------------------------------------
  // 2. 30 derniers stagiaires inscrits
  //    (dédupliqué par attendeeId : on garde la ligne la plus récente)
  // -------------------------------------------------------------------
  const latestByAttendee = new Map();
  attendees
    .filter((a) => a.attendee)
    .forEach((a) => {
      const prev = latestByAttendee.get(a.attendeeId);
      if (!prev || a.created > prev.created) latestByAttendee.set(a.attendeeId, a);
    });
  const derniersStagiaires = [...latestByAttendee.values()]
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 30)
    .map((a) => ({ nom: a.fullname, conventionId: a.conventionId, inscrit_le: a.created }));
  console.log('--- 2. 30 derniers stagiaires inscrits ---');
  console.table(derniersStagiaires);

  // -------------------------------------------------------------------
  // 3. Chiffre d'affaires facturé par mois
  // -------------------------------------------------------------------
  const caParMois = {};
  invoices.forEach((i) => {
    const m = monthKey(i.billingDate);
    if (m) caParMois[m] = (caParMois[m] || 0) + (i.amount || 0);
  });
  console.log('--- 3. CA facturé par mois (HT) ---');
  console.table(caParMois);

  // -------------------------------------------------------------------
  // 4. Devis à relancer (proposition sans signature, > 10 jours)
  // -------------------------------------------------------------------
  const devisARelancer = conventions
    .filter((c) => c.isProposal && !c.signingDate)
    .map((c) => ({ ...c, age: daysAgo(c.provisionalDate || c.created) }))
    .filter((c) => c.age !== null && c.age > 10)
    .sort((a, b) => b.age - a.age)
    .map((c) => ({ nom: c.name, code: c.proposalCode, statut: c.proposalStatus, age_jours: c.age }));
  console.log('--- 4. Devis à relancer (>10j sans signature) ---');
  console.table(devisARelancer);

  // -------------------------------------------------------------------
  // 5. Taux de remplissage moyen par mois (proxy : capacité max déclarée)
  //    NB: ne compte pas les inscrits réels par session, cf. limites.
  // -------------------------------------------------------------------
  const remplissageParMois = {};
  sessions
    .filter((s) => s.numberMaxi)
    .forEach((s) => {
      const m = monthKey(s.startDate);
      if (!m) return;
      if (!remplissageParMois[m]) remplissageParMois[m] = { nbSessions: 0, capaciteTotale: 0 };
      remplissageParMois[m].nbSessions += 1;
      remplissageParMois[m].capaciteTotale += s.numberMaxi;
    });
  console.log('--- 5. Sessions avec capacité déclarée, par mois ---');
  console.table(remplissageParMois);

  // -------------------------------------------------------------------
  // 6. Top formateurs (par nombre de sessions assignées + CA estimé)
  // -------------------------------------------------------------------
  const parFormateur = {};
  sessions
    .filter((s) => s.trainerId)
    .forEach((s) => {
      const key = s.trainerId;
      if (!parFormateur[key]) {
        parFormateur[key] = { nom: s.trainerName || key, nbSessions: 0, caEstime: 0 };
      }
      parFormateur[key].nbSessions += 1;
      parFormateur[key].caEstime += (s.dailyRate || 0) * (s.days || 0);
    });
  const topFormateurs = Object.values(parFormateur)
    .sort((a, b) => b.caEstime - a.caEstime)
    .slice(0, 10);
  console.log('--- 6. Top formateurs (CA estimé via dailyRate x days) ---');
  console.table(topFormateurs);

  window.__mcdf = { customers, conventions, invoices, attendees, sessions };
  console.log('Données complètes disponibles dans window.__mcdf pour exploration libre.');
})();
