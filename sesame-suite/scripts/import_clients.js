#!/usr/bin/env node
/**
 * Importe dans le CRM Sesame (POST /wa/crmProspect/create) les clients listés
 * dans clients_a_importer.json (63 clients du fichier pmexport.xls ayant du
 * CA en 2026, absents du CRM au 01/09/2026 — cf. session Claude Code).
 *
 * Pour chaque client, tente d'abord d'enrichir via l'API publique
 * recherche-entreprises.api.gouv.fr (SIRET, SIREN, forme juridique, date de
 * création, effectif salarié, adresse du siège, dirigeant → Référent) ; se
 * rabat sur les données du fichier Excel si l'API échoue ou ne matche rien.
 * Idempotent : relit d'abord le CRM et saute tout nom déjà présent (match
 * normalisé, insensible à la casse/accents/ponctuation).
 *
 * Usage (depuis sesame-suite/, ou dans le conteneur app en /app) :
 *   SESAME_BASE_URL=https://votre-domaine.com \
 *   SESAME_EMAIL=admin@sesame.technology \
 *   SESAME_PASSWORD=xxxxx \
 *   node scripts/import_clients.js
 *
 * Nécessite Node 18+ (fetch natif). Écrit scripts/import_results.json avec
 * le détail de ce qui a été créé/sauté/en erreur.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.SESAME_BASE_URL;
const EMAIL = process.env.SESAME_EMAIL;
const PASSWORD = process.env.SESAME_PASSWORD;
const DATA_PATH = path.join(__dirname, 'clients_a_importer.json');
const RESULTS_PATH = path.join(__dirname, 'import_results.json');

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('Variables requises manquantes : SESAME_BASE_URL, SESAME_EMAIL, SESAME_PASSWORD');
  process.exit(1);
}

const PAYS_OVERRIDE = {
  'BLUE EDEN srl': 'Belgique',
  'TDF ITALIA': 'Italie',
  'S2B INVEST SA': 'Suisse',
};

const FORME_JURIDIQUE_LABELS = {
  '1000': 'Entrepreneur individuel', '5202': 'Société en nom collectif', '5310': 'SCS',
  '5385': 'SCA', '5498': 'SARL', '5499': 'EURL', '5505': "SA à conseil d'administration",
  '5599': 'SA à directoire', '5710': 'SAS', '5720': 'SASU', '6540': 'SCI', '9220': 'Association',
};
const TRANCHE_EFFECTIF_LABELS = {
  '00': '0 salarié', '01': '1 à 2 salariés', '02': '3 à 5 salariés', '03': '6 à 9 salariés',
  '11': '10 à 19 salariés', '12': '20 à 49 salariés', '21': '50 à 99 salariés', '22': '100 à 199 salariés',
  '31': '200 à 249 salariés', '32': '250 à 499 salariés', '41': '500 à 999 salariés', '42': '1 000 à 1 999 salariés',
  '51': '2 000 à 4 999 salariés', '52': '5 000 à 9 999 salariés', '53': '10 000 salariés et plus',
};
function formeJuridiqueLabel(code) {
  if (!code) return '';
  return FORME_JURIDIQUE_LABELS[code] ? FORME_JURIDIQUE_LABELS[code] + ' (' + code + ')' : 'Code ' + code;
}
function effectifLabel(code) {
  if (!code) return '';
  return TRANCHE_EFFECTIF_LABELS[code] || ('Code ' + code);
}
function normName(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toUpperCase().trim().replace(/\s+/g, ' ');
}

async function enrichFromSiret(nom) {
  const url = 'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(nom) + '&limit=1';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  const e = (data.results || [])[0];
  if (!e) return null;
  const siege = e.siege || {};
  const street = [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' ');
  const city = siege.libelle_commune || '';
  const lat = siege.latitude != null ? parseFloat(siege.latitude) : null;
  const lng = siege.longitude != null ? parseFloat(siege.longitude) : null;
  const dirigeants = e.dirigeants || [];
  const dirigeant = dirigeants.find((d) => d.type_dirigeant === 'personne physique') || dirigeants[0];
  const referentName = dirigeant
    ? (dirigeant.type_dirigeant === 'personne morale' ? (dirigeant.denomination || '') : [dirigeant.prenoms, dirigeant.nom].filter(Boolean).join(' '))
      + (dirigeant.qualite ? ' (' + dirigeant.qualite + ')' : '')
    : '';
  return {
    denominationSociale: e.nom_complet || e.nom_raison_sociale || '',
    siret: siege.siret || '',
    siren: e.siren || '',
    formeJuridique: formeJuridiqueLabel(e.nature_juridique),
    dateCreationEntreprise: e.date_creation || null,
    effectifSalarie: effectifLabel(e.tranche_effectif_salarie),
    adresse: street || null,
    ville: city || null,
    lat, lng,
    referent: referentName || null,
  };
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  const loginRes = await fetch(BASE + '/wa/login/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) throw new Error('Login échoué : ' + loginRes.status + ' — vérifiez SESAME_BASE_URL/EMAIL/PASSWORD');
  const { token } = await loginRes.json();
  const authHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  console.log('Connecté à', BASE, '— lecture du CRM existant pour éviter les doublons…');
  const listRes = await fetch(BASE + '/wa/crmProspect/list', { headers: authHeaders });
  if (!listRes.ok) throw new Error('Lecture CRM échouée : ' + listRes.status);
  const existing = await listRes.json();
  const existingNames = new Set(existing.map((c) => normName(c.nom)));

  const results = { created: [], alreadyPresent: [], skippedNoAddress: [], apiEnriched: [], apiFailed: [], errors: [] };

  for (const row of rows) {
    const nom = (row.Nom || '').trim().replace(/\s+/g, ' ');
    if (existingNames.has(normName(nom))) {
      results.alreadyPresent.push(nom);
      console.log('DÉJÀ PRÉSENT (sauté) :', nom);
      continue;
    }

    const excelAdresse = row.Adresse ? String(row.Adresse).trim() : '';
    const excelVille = row.Ville ? String(row.Ville).trim() : '';

    let enrichment = null;
    try {
      enrichment = await enrichFromSiret(nom);
      if (enrichment) results.apiEnriched.push(nom);
    } catch (e) {
      results.apiFailed.push({ nom, error: e.message });
    }
    await new Promise((res) => setTimeout(res, 150));

    const adresse = (enrichment && enrichment.adresse) || excelAdresse;
    const ville = (enrichment && enrichment.ville) || excelVille;
    if (!adresse || !ville) {
      results.skippedNoAddress.push(nom);
      console.log('SKIP (aucune adresse, ni Excel ni API) :', nom);
      continue;
    }

    const pays = PAYS_OVERRIDE[nom] || 'France';
    const body = {
      nom, type: 'Client', adresse, ville, pays,
      tel: row['Téléphone'] || undefined,
      email: row['Email'] || undefined,
      contrat: 'oui',
      signe: row.ca2026 || null,
      ...(enrichment
        ? {
            denominationSociale: enrichment.denominationSociale || undefined,
            siret: enrichment.siret || undefined,
            siren: enrichment.siren || undefined,
            formeJuridique: enrichment.formeJuridique || undefined,
            dateCreationEntreprise: enrichment.dateCreationEntreprise || undefined,
            effectifSalarie: enrichment.effectifSalarie || undefined,
            lat: enrichment.lat, lng: enrichment.lng,
            referent: enrichment.referent || undefined,
          }
        : {}),
    };

    try {
      const r = await fetch(BASE + '/wa/crmProspect/create', { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      results.created.push({ nom, id: j.id, enriched: !!enrichment });
      console.log((enrichment ? '[SIRET OK] ' : '[Excel]   ') + 'Créé :', nom, '->', j.id);
    } catch (e) {
      results.errors.push({ nom, error: e.message });
      console.log('ERREUR création :', nom, '-', e.message);
    }
  }

  console.log('\n=== BILAN ===');
  console.log('Créés :', results.created.length);
  console.log('Déjà présents (sautés) :', results.alreadyPresent.length);
  console.log('Enrichis via API SIRET :', results.apiEnriched.length);
  console.log('API SIRET indisponible/échec :', results.apiFailed.length);
  console.log('Non importés (aucune adresse) :', results.skippedNoAddress.length, results.skippedNoAddress);
  console.log('Erreurs de création :', results.errors.length, results.errors);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('\nDétail écrit dans', RESULTS_PATH);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
