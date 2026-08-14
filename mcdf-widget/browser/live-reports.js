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
 *
 * IMPORTANT : un compte peut avoir accès à plusieurs "entity" (agences /
 * comptes clients) à la fois — les appels /wa/{entite}/list ne se
 * limitent PAS automatiquement à celle sélectionnée dans le menu en haut
 * de l'appli. Il faut filtrer explicitement par ENTITY_ID ci-dessous.
 * Pour lister les entités accessibles et leurs id :
 *
 *   fetch(`/wa/entity/list?nopaging=1&_dc=${Date.now()}`)
 *     .then(r => r.json())
 *     .then(d => console.table(d.root.map(e => ({id: e.id, name: e.name}))));
 */
(async function mcdfLiveReports() {
  const ENTITY_ID = 'E00000361'; // DEMO — change pour cibler une autre entité

  async function fetchAll(entity) {
    const res = await fetch(`/wa/${entity}/list?nopaging=1&_dc=${Date.now()}`);
    const data = await res.json();
    if (!data.success) {
      throw new Error(`${entity}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    // Le serveur ne restreint pas forcément à l'entité affichée dans le
    // menu de l'appli pour un compte multi-entités — on filtre donc
    // nous-mêmes sur le champ entityId, présent sur chaque enregistrement.
    return data.root.filter((r) => r.entityId === ENTITY_ID);
  }

  const monthKey = (iso) => (iso ? iso.slice(0, 7) : null);
  const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null);

  console.log(`Chargement des entités MCDF (filtré sur entityId=${ENTITY_ID})...`);
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

  // -------------------------------------------------------------------
  // 7. Comparaison année en cours vs année précédente, à date égale (YTD)
  // -------------------------------------------------------------------
  const now = new Date();
  const yearN = now.getFullYear();
  const yearN1 = yearN - 1;
  const cutoffMonth = now.getMonth(); // 0-indexé
  const cutoffDay = now.getDate();

  const inYtd = (dateStr, year) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (d.getFullYear() !== year) return false;
    return d.getMonth() < cutoffMonth || (d.getMonth() === cutoffMonth && d.getDate() <= cutoffDay);
  };
  const pctDelta = (cur, prev) => {
    if (!prev) return cur ? Infinity : 0;
    return Math.round(((cur - prev) / prev) * 1000) / 10;
  };

  const caN = invoices.filter((i) => inYtd(i.billingDate, yearN)).reduce((s, i) => s + (i.amount || 0), 0);
  const caN1 = invoices.filter((i) => inYtd(i.billingDate, yearN1)).reduce((s, i) => s + (i.amount || 0), 0);

  const clientsN = customers.filter((c) => inYtd(c.created, yearN)).length;
  const clientsN1 = customers.filter((c) => inYtd(c.created, yearN1)).length;

  const stagiairesN = new Set(
    attendees.filter((a) => a.attendee && inYtd(a.created, yearN)).map((a) => a.attendeeId)
  ).size;
  const stagiairesN1 = new Set(
    attendees.filter((a) => a.attendee && inYtd(a.created, yearN1)).map((a) => a.attendeeId)
  ).size;

  const devisSignesN = conventions.filter((c) => c.isProposal && inYtd(c.signingDate, yearN)).length;
  const devisSignesN1 = conventions.filter((c) => c.isProposal && inYtd(c.signingDate, yearN1)).length;

  console.log(`--- 7. Comparaison ${yearN} vs ${yearN1}, jusqu'au ${cutoffDay}/${cutoffMonth + 1} (YTD) ---`);
  console.table({
    'CA facturé (HT)': { [yearN]: caN.toFixed(2), [yearN1]: caN1.toFixed(2), 'delta %': pctDelta(caN, caN1) },
    'Nouveaux clients': { [yearN]: clientsN, [yearN1]: clientsN1, 'delta %': pctDelta(clientsN, clientsN1) },
    'Stagiaires inscrits': { [yearN]: stagiairesN, [yearN1]: stagiairesN1, 'delta %': pctDelta(stagiairesN, stagiairesN1) },
    'Devis signés': { [yearN]: devisSignesN, [yearN1]: devisSignesN1, 'delta %': pctDelta(devisSignesN, devisSignesN1) },
  });

  window.__mcdf = { customers, conventions, invoices, attendees, sessions };
  console.log('Données complètes disponibles dans window.__mcdf pour exploration libre.');
})();
