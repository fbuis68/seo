import crypto from "node:crypto";
import { Router } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { getSmtpConfig } from "../lib/email";
import { graphConfigured, createGraphSubscription, renewGraphSubscription, deleteGraphSubscription, getGraphMessage } from "../lib/graph";
import { extractTicketTag, findTicketByTag, createTicketFromInboundEmail, appendInboundReply } from "../lib/ticketInbound";

/**
 * Import automatique des emails de la boîte support en tickets, via un
 * abonnement webhook Microsoft Graph (changeType=created sur les messages
 * de la boîte) — remplace la règle Outlook + flux Power Automate utilisée
 * jusque-là pour du simple signal d'engagement (cf. crmProspect.ts
 * inboundSignal). Portée CRM/Sesame uniquement, une seule boîte surveillée
 * à la fois (ligne singleton GraphMailSubscription).
 *
 * Procédure de mise en service côté Azure AD :
 * docs/microsoft-graph-inbound-tickets.md
 */
export const graphMailRouter = Router();

async function getSingleton() {
  return prisma.graphMailSubscription.findFirst({ orderBy: { createdAt: "asc" } });
}

// ═══════════════════════════ ADMIN (CRM Sesame) ═══════════════════════════

graphMailRouter.get(
  "/graphMail/status",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const sub = await getSingleton();
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
 * boîte support configurée (SmtpConfig.supportFromEmail, repli sur
 * fromEmail). Le webhook exige une URL de notification publique en HTTPS
 * (config.publicBaseUrl) — échoue explicitement si absente plutôt que
 * d'envoyer une URL inutilisable à Graph.
 */
graphMailRouter.post(
  "/graphMail/activate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    if (!graphConfigured()) throw new HttpError(400, "Microsoft Graph non configuré côté serveur (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET)");
    if (!config.publicBaseUrl) throw new HttpError(400, "PUBLIC_BASE_URL non configuré — requis pour l'URL de notification Graph");

    const smtp = await getSmtpConfig(null);
    const mailbox = smtp?.supportFromEmail || smtp?.fromEmail;
    if (!mailbox) throw new HttpError(400, "Configurez d'abord une adresse d'expéditeur dans le panneau Canaux (serveur email)");

    const existing = await getSingleton();
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
        update: { mailbox, subscriptionId: created.id, expiresAt: new Date(created.expirationDateTime), clientState, status: "active", lastError: null },
        create: { mailbox, subscriptionId: created.id, expiresAt: new Date(created.expirationDateTime), clientState, status: "active" },
      });
      res.json({ status: sub.status, mailbox: sub.mailbox, expiresAt: sub.expiresAt });
    } catch (e) {
      const message = e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Erreur inattendue";
      await prisma.graphMailSubscription.upsert({
        where: { id: existing?.id || "__none__" },
        update: { mailbox, clientState, status: "error", lastError: message },
        create: { mailbox, clientState, status: "error", lastError: message },
      });
      throw new HttpError(502, `Activation Microsoft Graph échouée : ${message}`);
    }
  })
);

graphMailRouter.post(
  "/graphMail/deactivate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const existing = await getSingleton();
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

async function processNotifications(items: GraphNotificationItem[]) {
  const sub = await getSingleton();
  if (!sub || sub.status !== "active") return;

  for (const item of items) {
    if (item.clientState !== sub.clientState) {
      console.warn("[graphMail] notification rejetée (clientState invalide)");
      continue;
    }
    const messageId = item.resourceData?.id;
    if (!messageId) continue;

    try {
      await processOneMessage(sub.mailbox, messageId);
    } catch (e) {
      console.error(`[graphMail] échec sur le message ${messageId}:`, e);
    }
  }
}

async function processOneMessage(mailbox: string, messageId: string) {
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
 * Renouvelle l'abonnement s'il expire dans moins de 6h — appelé
 * périodiquement par lib/graphSubscriptionScheduler.ts. Un abonnement non
 * renouvelé à temps expire silencieusement côté Graph (aucun email ne
 * notifie l'hôtel), d'où la marge large plutôt qu'un renouvellement au
 * dernier moment.
 */
export async function renewGraphSubscriptionIfNeeded(): Promise<void> {
  const sub = await getSingleton();
  if (!sub || sub.status !== "active" || !sub.subscriptionId) return;
  if (sub.expiresAt && sub.expiresAt.getTime() - Date.now() > 6 * 60 * 60_000) return;

  try {
    const renewed = await renewGraphSubscription(sub.subscriptionId);
    await prisma.graphMailSubscription.update({
      where: { id: sub.id },
      data: { expiresAt: new Date(renewed.expirationDateTime), lastError: null },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur inattendue";
    console.error("[graphMail] renouvellement de l'abonnement échoué:", message);
    await prisma.graphMailSubscription.update({ where: { id: sub.id }, data: { status: "error", lastError: message } });
  }
}
