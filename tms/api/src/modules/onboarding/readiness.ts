import { toCents } from '../../core/decimal';
import { Tx, many, one } from '../../core/db';
import { EXEMPTION_TEXT, currentProfile, profileProblems } from './billing-profile';

export type ReadinessState = 'not_ready' | 'ready_to_prepare' | 'ready_to_issue' | 'ready_to_transmit';
export interface Check {
  code: string; ok: boolean; severity: 'blocking' | 'warning';
  /** Étape « préparer » (brouillon), « émettre » (numéro définitif) ou « transmettre ». */
  level: 'prepare' | 'issue' | 'transmit';
  message: string; fix?: string; screen?: string;
}

const addr = (a: any) => !!(a && (a.line1 || a.street) && (a.postal_code || a.postalCode) && a.city);

/**
 * Diagnostic « prêt à facturer » (FAC 06), exécuté côté serveur : à l'ouverture du diagnostic et
 * immédiatement avant émission. Contourner l'interface ne permet pas d'éviter le contrôle.
 * Sans facture : état global de l'organisme. Avec facture : contrôles du document en plus.
 */
export async function readiness(tx: Tx, o: { permissions?: Set<string>; invoiceId?: string | null; today?: string }) {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const t = (await one(tx, `SELECT t.*, (now() AT TIME ZONE t.timezone)::date::text today FROM tenants t WHERE t.id = app_tenant()`))!;
  const today = o.today ?? t.today;

  // Émetteur (FAC 01).
  add({ code: 'emitter_identity', level: 'prepare', severity: 'blocking', ok: !!t.legal_name?.trim(), message: 'Raison sociale de l’émetteur.', screen: '/onboarding?step=company' });
  add({ code: 'emitter_address', level: 'issue', severity: 'blocking', ok: addr(t.address), message: 'Adresse complète de l’émetteur (rue, code postal, ville).', screen: '/onboarding?step=company' });
  add({ code: 'emitter_siret', level: 'issue', severity: 'blocking', ok: /^\d{14}$/.test(t.siret ?? ''), message: 'SIRET de l’émetteur (14 chiffres).', screen: '/onboarding?step=company' });
  add({ code: 'emitter_logo', level: 'issue', severity: 'warning', ok: !!(await one(tx, `SELECT 1 FROM tenant_branding WHERE logo_png IS NOT NULL OR logo_jpeg IS NOT NULL LIMIT 1`)),
    message: 'Logo absent (facultatif : n’empêche pas la facturation).', screen: '/settings' });

  // Règles fiscales et de calcul confirmées (FAC 02, 05).
  const profile = await currentProfile(tx);
  const problems = profile ? profileProblems(profile.data) : ['Profil de facturation non renseigné.'];
  add({ code: 'billing_profile', level: 'issue', severity: 'blocking', ok: !problems.length, message: problems.join(' ') || 'Profil de facturation complet.', screen: '/onboarding?step=billing' });
  add({ code: 'billing_profile_confirmed', level: 'issue', severity: 'blocking', ok: !!profile?.confirmed_at,
    message: profile?.confirmed_at ? 'Règles fiscales et de calcul confirmées.' : 'Règles fiscales, arrondis et conditions de paiement à confirmer par un responsable.', screen: '/onboarding?step=billing' });

  // Séquence et bascule (FAC 03).
  const series = await one(tx, `SELECT * FROM invoice_series WHERE code='FAC' AND NOT is_historical`);
  add({ code: 'series_confirmed', level: 'issue', severity: 'blocking', ok: !!series?.confirmed_at,
    message: series?.confirmed_at ? 'Numérotation validée.' : 'Numérotation à valider : préfixe, prochain numéro, dernier numéro de l’ancien outil.', screen: '/onboarding?step=billing' });
  if (series) {
    const next = `${series.prefix}${today.slice(0, 4)}-${String(series.next_number).padStart(5, '0')}`;
    const clash = await one(tx, `SELECT number FROM invoices WHERE number=$1 LIMIT 1`, [next]);
    add({ code: 'series_collision', level: 'issue', severity: 'blocking', ok: !clash, message: clash ? `Le prochain numéro ${next} existe déjà (historique ou ancien outil).` : `Prochain numéro : ${next}.`, screen: '/onboarding?step=billing' });
    if (series.cutover_on) add({ code: 'cutover', level: 'issue', severity: 'blocking', ok: today >= String(series.cutover_on).slice(0, 10),
      message: today >= String(series.cutover_on).slice(0, 10) ? 'Bascule effectuée : émission réservée à ce logiciel.' : `Émission ouverte à partir de la date de bascule (${String(series.cutover_on).slice(0, 10)}).`, screen: '/onboarding?step=billing' });
  }

  // Droits (l'émission est un droit distinct de la préparation).
  if (o.permissions) add({ code: 'rights', level: 'issue', severity: 'blocking', ok: o.permissions.has('invoices.issue'), message: o.permissions.has('invoices.issue') ? 'Droit d’émission.' : 'Vous n’avez pas le droit d’émettre : un responsable facturation doit émettre.' });

  // Reprise en cours : n'empêche pas de facturer un client déjà valide.
  const importing = await one(tx, `SELECT 1 FROM import_batches WHERE status IN ('committing') LIMIT 1`);
  add({ code: 'import_running', level: 'issue', severity: 'warning', ok: !importing, message: importing ? 'Reprise de données en cours (les clients déjà repris restent facturables).' : 'Aucune reprise en cours.' });

  // Document (FAC 04, 06).
  let invoice: any = null;
  if (o.invoiceId) {
    invoice = await one(tx, `SELECT i.*, c.name client_name, c.billing_address, c.kind client_kind, c.siret client_siret, c.billing_email, c.deleted_at client_deleted
                               FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=$1`, [o.invoiceId]);
    if (invoice) {
      const lines = await many(tx, `SELECT * FROM invoice_lines WHERE invoice_id=$1`, [invoice.id]);
      add({ code: 'client_identity', level: 'prepare', severity: 'blocking', ok: !!invoice.client_name && !invoice.client_deleted, message: `Client : ${invoice.client_name ?? '—'}.`, screen: `/clients` });
      add({ code: 'client_address', level: 'issue', severity: 'blocking', ok: addr(invoice.billing_address), message: addr(invoice.billing_address) ? 'Adresse de facturation du client.' : `Adresse de facturation du client « ${invoice.client_name} » incomplète.`, screen: `/clients` });
      add({ code: 'lines', level: 'prepare', severity: 'blocking', ok: lines.length > 0, message: lines.length ? `${lines.length} ligne(s).` : 'Au moins une ligne facturable.' });
      const regime = profile?.data?.vatRegime;
      const badVat = regime && regime !== 'subject' ? lines.filter((l: any) => Number(l.vat_rate) !== 0) : [];
      add({ code: 'vat_consistency', level: 'issue', severity: 'blocking', ok: !badVat.length,
        message: badVat.length ? `${badVat.length} ligne(s) avec TVA alors que le régime est « ${EXEMPTION_TEXT[regime!] ?? regime} ».` : 'Taux de TVA cohérents avec le régime.' });
      const sum = lines.reduce((a: bigint, l: any) => a + toCents(l.total_ht), 0n);
      add({ code: 'amounts', level: 'issue', severity: 'blocking', ok: sum === toCents(invoice.total_ht) && (invoice.kind === 'credit_note' || toCents(invoice.total_ttc) >= 0n),
        message: sum === toCents(invoice.total_ht) ? 'Montants cohérents.' : 'Total HT différent de la somme des lignes : rouvrir le brouillon pour recalculer.' });
      // Doublon : même client, même session, même montant, déjà émise et non annulée par avoir.
      const dup = invoice.kind === 'invoice' ? await one(tx, `SELECT number FROM invoices i WHERE i.id<>$1 AND i.status='issued' AND i.kind='invoice' AND i.client_id=$2
          AND i.session_id IS NOT DISTINCT FROM $3 AND i.total_ttc=$4 AND $3::uuid IS NOT NULL
          AND coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id=i.id AND cn.status='issued'),0) < i.total_ttc LIMIT 1`,
        [invoice.id, invoice.client_id, invoice.session_id, invoice.total_ttc]) : null;
      add({ code: 'duplicate', level: 'issue', severity: 'blocking', ok: !dup, message: dup ? `Facturation en double : la facture ${dup.number} porte déjà ce montant pour ce client et cette session.` : 'Pas de double facturation détectée.' });
      // Transmission (FAC 08).
      add({ code: 'transmit_channel', level: 'transmit', severity: 'blocking', ok: !!invoice.billing_email || !!profile?.data?.einvoiceRequired,
        message: invoice.billing_email ? `Envoi possible à ${invoice.billing_email}.` : 'Email de facturation du client absent : téléchargez la facture ou complétez l’email.', screen: '/clients' });
    } else add({ code: 'invoice', level: 'prepare', severity: 'blocking', ok: false, message: 'Facture introuvable.' });
  } else {
    const client = await one(tx, `SELECT count(*)::int n FROM clients WHERE deleted_at IS NULL`);
    add({ code: 'has_client', level: 'prepare', severity: 'blocking', ok: client!.n > 0, message: client!.n ? `${client!.n} client(s).` : 'Créez ou importez au moins un client.', screen: '/clients' });
  }
  if (profile?.data?.einvoiceRequired) {
    const ok = !!(await one(tx, `SELECT 1 FROM invoices WHERE einvoice_status IN ('accepted','transmitted','received','paid') LIMIT 1`));
    add({ code: 'einvoice_circuit', level: 'transmit', severity: 'blocking', ok, message: ok ? 'Circuit de facturation électronique vérifié.' : 'Circuit de facturation électronique requis : connectivité et accusés à vérifier.' });
  }

  const blocking = (lvl: Check['level'][]) => checks.filter((c) => !c.ok && c.severity === 'blocking' && lvl.includes(c.level));
  const state: ReadinessState = blocking(['prepare']).length ? 'not_ready' : blocking(['issue']).length ? 'ready_to_prepare' : blocking(['transmit']).length ? 'ready_to_issue' : 'ready_to_transmit';
  return {
    state, checkedAt: new Date().toISOString(), checks,
    blocking: checks.filter((c) => !c.ok && c.severity === 'blocking'),
    warnings: checks.filter((c) => !c.ok && c.severity === 'warning'),
    canIssue: state === 'ready_to_issue' || state === 'ready_to_transmit',
  };
}
