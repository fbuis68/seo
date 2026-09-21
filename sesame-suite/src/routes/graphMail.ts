import crypto from "node:crypto";
import { Router } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { getSmtpConfig } from "../lib/email";
import { graphConfigured, createGraphSubscription, renewGraphSubscription, deleteGraphSubscription, getGraphMessage } from "../lib/graph";
import { extractTicketTag, findTicketByTag, createTicketFromInboundEmail, appendInboundReply } from "../lib/ticketInbound";
import { ACCEPTED_MIME_TYPES } from "../lib/accDocument";
import { processUploadedDocument, PipelineError } from "../lib/accPipeline";
import { recordAuditLog } from "../lib/accAudit";

/**
 * Import automatique d'emails via un abonnement webhook Microsoft Graph
 * (changeType=created sur les messages d'une boîte) — remplace la règle
 * Outlook + flux Power Automate utilisée jusque-là pour du simple signal
 * d'engagement (cf. crmProspect.ts inboundSignal). Portée CRM/Sesame
 * uniquement.
 *
 * Trois "purpose" distincts partagent cette même plomberie (16/09/2026,
 * étendu le 21/09/2026 pour la vente) :
 * - "tickets" (comportement d'origine) : chaque email devient/complète un
 *   CrmTicket.
 * - "accounting" : chaque pièce jointe facture (PDF/image/XML) d'un email
 *   reçu sur la boîte configurée devient une AccInvoice direction="purchase"
 *   via lib/accPipeline.ts — cf. module Comptabilité.
 * - "accounting_sale" : même mécanique, boîte séparée, direction="sale" —
 *   une boîte de réception des factures fournisseur ne doit jamais recevoir
 *   aussi les propres factures de vente de l'établissement (expéditeurs,
 *   volumétrie et suivi totalement différents), d'où deux boîtes distinctes
 *   plutôt qu'un simple bouton "sens par défaut" sur une boîte unique.
 * Au plus une boîte active par purpose (pas une ligne unique globale comme
 * avant) — la notification webhook retrouve la bonne ligne par
 * subscriptionId plutôt que de supposer une boîte unique.
 *
 * Procédure de mise en service côté Azure AD : docs/microsoft-graph-inbound-tickets.md
 * (même app, éventuellement étendre l'ApplicationAccessPolicy Exchange pour
 * couvrir la ou les boîtes comptabilité en plus de la boîte support).
 */
export const graphMailRouter = Router();

type GraphMailPurpose = "tickets" | "accounting" | "accounting_sale";

function parsePurpose(v: unknown): GraphMailPurpose {
  if (v === "accounting" || v === "accounting_sale") return v;
  return "tickets";
}

async function getByPurpose(purpose: GraphMailPurpose) {
  return prisma.graphMailSubscription.findFirst({ where: { purpose }, orderBy: { createdAt: "asc" } });
}

// ═══════════════════════════ ADMIN (CRM Sesame) ═══════════════════════════

graphMailRouter.get(
  "/graphMail/status",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const purpose = parsePurpose(req.query.purpose);
    const sub = await getByPurpose(purpose);
    res.json({
      configured: graphConfigured(),
      status: sub?.status || "inactive",
      mailbox: sub?.mailbox || "",
      expiresAt: sub?.expiresAt || null,
      lastError: sub?.lastError || "",
    });
  })
);

/**
 * POST /wa/graphMail/activate — crée (ou recrée) l'abonnement Graph sur la
 * boîte configurée. Pour purpose="tickets" (défaut), boîte dérivée de
 * SmtpConfig.supportFromEmail/fromEmail comme avant. Pour
 * purpose="accounting", `mailbox` est obligatoire dans le corps (aucun
 * champ SmtpConfig équivalent). Le webhook exige une URL de notification
 * publique en HTTPS (config.publicBaseUrl) — échoue explicitement si
 * absente plutôt que d'envoyer une URL inutilisable à Graph.
 */
graphMailRouter.post(
  "/graphMail/activate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    if (!graphConfigured()) throw new HttpError(400, "Microsoft Graph non configuré côté serveur (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET)");
    if (!config.publicBaseUrl) throw new HttpError(400, "PUBLIC_BASE_URL non configuré — requis pour l'URL de notification Graph");

    const purpose = parsePurpose(req.body?.purpose);
    let mailbox: string | undefined;
    if (purpose === "accounting" || purpose === "accounting_sale") {
      mailbox = (req.body?.mailbox as string || "").trim();
      if (!mailbox || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox)) throw new HttpError(400, "Adresse email de la boîte comptabilité invalide ou manquante");
    } else {
      const smtp = await getSmtpConfig(null);
      mailbox = smtp?.supportFromEmail || smtp?.fromEmail || undefined;
      if (!mailbox) throw new HttpError(400, "Configurez d'abord une adresse d'expéditeur dans le panneau Canaux (serveur email)");
    }

    const existing = await getByPurpose(purpose);
    const clientState = crypto.randomBytes(24).toString("hex");
    const notificationUrl = `${config.publicBaseUrl}/wa/graphMail/notify`;

    try {
      if (existing?.subscriptionId) {
        // Une boîte différente a été choisie depuis la dernière activation,
        // ou le clientState doit être renouvelé : on repart d'un abonnement
        // propre plutôt que de laisser l'ancien tourner en parallèle.
        await deleteGraphSubscription(existing.subscriptionId).catch(() => {});
      }
      const created = await createGraphSubscription(mailbox, notificationUrl, clientState);
      const sub = await prisma.graphMailSubscription.upsert({
        where: { id: existing?.id || "__none__" },
        update: { purpose, mailbox, subscriptionId: created.id, expiresAt: new Date(created.expirationDateTime), clientState, status: "active", lastError: null },
        create: { purpose, mailbox, subscriptionId: created.id, expiresAt: new Date(created.expirationDateTime), clientState, status: "active" },
      });
      res.json({ status: sub.status, mailbox: sub.mailbox, expiresAt: sub.expiresAt });
    } catch (e) {
      const message = e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Erreur inattendue";
      await prisma.graphMailSubscription.upsert({
        where: { id: existing?.id || "__none__" },
        update: { purpose, mailbox, clientState, status: "error", lastError: message },
        create: { purpose, mailbox, clientState, status: "error", lastError: message },
      });
      throw new HttpError(502, `Activation Microsoft Graph échouée : ${message}`);
    }
  })
);

graphMailRouter.post(
  "/graphMail/deactivate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const purpose = parsePurpose(req.body?.purpose);
    const existing = await getByPurpose(purpose);
    if (existing?.subscriptionId) await deleteGraphSubscription(existing.subscriptionId).catch(() => {});
    if (existing) {
      await prisma.graphMailSubscription.update({ where: { id: existing.id }, data: { subscriptionId: null, status: "inactive", lastError: null } });
    }
    res.json({ ok: true });
  })
);

// ═══════════════════════════ WEBHOOK (Microsoft Graph) ═════════════════════

interface GraphNotificationItem {
  subscriptionId: string;
  clientState: string;
  resourceData: { id: string };
}

/**
 * POST /wa/graphMail/notify — public, appelé uniquement par Microsoft
 * Graph (aucune session admin possible côté Graph, d'où la vérification
 * par clientState plutôt qu'un Bearer token, même principe que
 * X-Inbound-Secret ailleurs dans ce fichier).
 *
 * Deux formes d'appel distinctes, cf. doc Graph "webhooks" :
 * 1. Validation (à la création/au renouvellement de l'abonnement) : un
 *    GET-like POST avec ?validationToken=... et sans corps utile — Graph
 *    exige de le renvoyer tel quel en text/plain sous 10s, sans quoi
 *    l'abonnement n'est jamais créé.
 * 2. Notification réelle : { value: [ { subscriptionId, clientState,
 *    resourceData:{id} }, ... ] } — ne contient JAMAIS le contenu de
 *    l'email (sujet/corps/expéditeur), seulement une référence ; d'où
 *    l'appel à getGraphMessage() pour chaque item. Traité APRÈS avoir
 *    répondu (202) : Graph attend un accusé rapide, pas la fin du
 *    traitement, et retente sinon inutilement une notification déjà reçue.
 */
graphMailRouter.post("/graphMail/notify", (req, res) => {
  const validationToken = req.query.validationToken as string | undefined;
  if (validationToken !== undefined) {
    res.status(200).type("text/plain").send(validationToken);
    return;
  }

  res.status(202).json({ ok: true });

  const items = ((req.body?.value as GraphNotificationItem[]) || []).filter(Boolean);
  if (!items.length) return;

  processNotifications(items).catch((e) => console.error("[graphMail] traitement notification échoué:", e));
});

/**
 * Retrouve la boîte concernée par item.subscriptionId plutôt que de
 * supposer une boîte unique — nécessaire depuis que plusieurs abonnements
 * (un par purpose) peuvent coexister.
 */
async function processNotifications(items: GraphNotificationItem[]) {
  for (const item of items) {
    const subscriptionId = item.subscriptionId;
    if (!subscriptionId) continue;
    const sub = await prisma.graphMailSubscription.findFirst({ where: { subscriptionId, status: "active" } });
    if (!sub) {
      console.warn(`[graphMail] notification reçue pour un subscriptionId inconnu/inactif (${subscriptionId}) — ignorée`);
      continue;
    }
    if (item.clientState !== sub.clientState) {
      console.warn("[graphMail] notification rejetée (clientState invalide)");
      continue;
    }
    const messageId = item.resourceData?.id;
    if (!messageId) continue;

    try {
      if (sub.purpose === "accounting" || sub.purpose === "accounting_sale") {
        await processAccountingMessage(sub.mailbox, messageId, sub.purpose === "accounting_sale" ? "sale" : "purchase");
      } else {
        await processTicketMessage(sub.mailbox, messageId);
      }
    } catch (e) {
      console.error(`[graphMail] échec sur le message ${messageId} (${sub.purpose}):`, e);
    }
  }
}

async function processTicketMessage(mailbox: string, messageId: string) {
  const already = await prisma.crmTicketMessage.findUnique({ where: { graphMessageId: messageId } });
  if (already) return; // notification déjà traitée (livraison "at least once" de Graph)

  const msg = await getGraphMessage(mailbox, messageId);
  if (!msg.from || msg.from.toLowerCase() === mailbox.toLowerCase()) return; // évite toute boucle sur la boîte elle-même

  const attachments = msg.attachments.map((a) => `data:${a.contentType};base64,${a.contentBytes}`);
  const tag = extractTicketTag(msg.subject);
  const ticket = tag ? await findTicketByTag(tag) : null;

  if (ticket) {
    await appendInboundReply(ticket, { authorName: msg.fromName || msg.from, body: msg.bodyText, attachments, graphMessageId: msg.id });
  } else {
    await createTicketFromInboundEmail({
      email: msg.from,
      name: msg.fromName,
      subject: msg.subject,
      body: msg.bodyText,
      attachments,
      graphMessageId: msg.id,
    });
  }
}

/**
 * Chaque pièce jointe d'un email reçu sur la boîte comptabilité, dont le
 * type MIME est accepté par le pipeline (PDF/JPEG/PNG/TIFF/XML), devient
 * une facture (source="email", direction selon la boîte — purchase pour
 * "accounting", sale pour "accounting_sale") — même chaîne que le dépôt
 * manuel (cf. lib/accPipeline.ts). La déduplication par hash SHA-256
 * (lib/accDocument.ts) protège déjà contre la livraison "at least once" de
 * Graph : un même email retraité produit les mêmes pièces jointes, donc le
 * même hash, donc aucune facture en double — pas de bookkeeping
 * supplémentaire nécessaire ici. Une pièce jointe en échec n'interrompt pas
 * le traitement des autres.
 */
async function processAccountingMessage(mailbox: string, messageId: string, direction: "purchase" | "sale") {
  const msg = await getGraphMessage(mailbox, messageId);
  console.log(`[graphMail] message comptabilité reçu de ${msg.from || "(expéditeur inconnu)"} — "${msg.subject}" — ${msg.attachments.length} pièce(s) jointe(s) : ${msg.attachments.map((a) => `${a.name} (${a.contentType})`).join(", ") || "aucune"}`);
  if (!msg.from || msg.from.toLowerCase() === mailbox.toLowerCase()) {
    console.log(`[graphMail] message ${messageId} ignoré (provient de la boîte elle-même, anti-boucle)`);
    return;
  }

  const eligible = msg.attachments.filter((a) => ACCEPTED_MIME_TYPES.has(a.contentType));
  if (!eligible.length) {
    console.log(`[graphMail] message ${messageId} ignoré : aucune pièce jointe d'un type accepté (PDF/JPEG/PNG/TIFF/XML)`);
    return;
  }

  for (const att of eligible) {
    try {
      const result = await processUploadedDocument(null, {
        filename: att.name,
        mimeType: att.contentType,
        base64: att.contentBytes,
        direction,
        source: "email",
      });
      await recordAuditLog({
        entityId: null,
        userId: null,
        action: result.isDuplicateDocument ? "document_upload_duplicate" : "document_uploaded",
        targetType: "AccInvoice",
        targetId: result.invoice.id,
        newValue: { status: result.invoice.status, direction: result.invoice.direction, source: "email", from: msg.from, subject: msg.subject },
        source: "api",
      });
    } catch (e) {
      const message = e instanceof PipelineError ? e.message : e instanceof Error ? e.message : "Erreur inattendue";
      console.error(`[graphMail] pièce jointe "${att.name}" du message ${messageId} ignorée :`, message);
    }
  }
}

/**
 * Renouvelle les abonnements actifs qui expirent dans moins de 6h — appelé
 * périodiquement par lib/graphSubscriptionScheduler.ts. Un abonnement non
 * renouvelé à temps expire silencieusement côté Graph (aucun email ne
 * notifie l'hôtel), d'où la marge large plutôt qu'un renouvellement au
 * dernier moment. Renouvelle TOUTES les boîtes actives (plusieurs purpose
 * possibles), pas une seule.
 */
export async function renewGraphSubscriptionIfNeeded(): Promise<void> {
  const subs = await prisma.graphMailSubscription.findMany({ where: { status: "active", subscriptionId: { not: null } } });
  for (const sub of subs) {
    if (sub.expiresAt && sub.expiresAt.getTime() - Date.now() > 6 * 60 * 60_000) continue;
    try {
      const renewed = await renewGraphSubscription(sub.subscriptionId!);
      await prisma.graphMailSubscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(renewed.expirationDateTime), lastError: null },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erreur inattendue";
      console.error(`[graphMail] renouvellement de l'abonnement (${sub.purpose}) échoué:`, message);
      await prisma.graphMailSubscription.update({ where: { id: sub.id }, data: { status: "error", lastError: message } });
    }
  }
}
