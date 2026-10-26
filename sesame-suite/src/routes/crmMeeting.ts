import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { graphConfigured } from "../lib/graph";
import { resolveGraphUserId, createOnlineMeeting, listTranscripts, getTranscriptText, listRecordings, getRecordingStream } from "../lib/graphMeetings";
import { generateMeetingSummary } from "../lib/aiClaude";
import { getSmtpConfig, sendEmailRaw } from "../lib/email";

/**
 * Réunions Teams planifiées depuis une fiche prospect (24/10/2026, demande
 * client) — portée CRM/Sesame uniquement (entityId=null), même convention
 * que routes/crmTicket.ts. Organisateur = le commercial connecté
 * (req.admin.email, doit correspondre à une vraie boîte Microsoft 365 du
 * tenant) — pas de compte partagé.
 */
export const crmMeetingRouter = Router();

function shapeMeeting(m: {
  id: string;
  prospectId: string;
  subject: string;
  organizerEmail: string;
  startDateTime: Date;
  endDateTime: Date;
  joinUrl: string;
  status: string;
  recordingGraphId: string | null;
  summaryText: string | null;
  actionItems: unknown;
  fetchedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: m.id,
    prospectId: m.prospectId,
    subject: m.subject,
    organizerEmail: m.organizerEmail,
    startDateTime: m.startDateTime,
    endDateTime: m.endDateTime,
    joinUrl: m.joinUrl,
    status: m.status,
    hasRecording: !!m.recordingGraphId,
    summaryText: m.summaryText,
    actionItems: (m.actionItems as string[] | null) || [],
    fetchedAt: m.fetchedAt,
    createdAt: m.createdAt,
  };
}

/**
 * GET /wa/crmMeeting/list?prospectId=
 */
crmMeetingRouter.get(
  "/crmMeeting/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || "";
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const rows = await prisma.crmMeeting.findMany({ where: { prospectId }, orderBy: { startDateTime: "desc" } });
    res.json(rows.map(shapeMeeting));
  })
);

interface CreateBody {
  prospectId: string;
  subject: string;
  startDateTime: string;
  endDateTime: string;
}

/**
 * POST /wa/crmMeeting/create — planifie la réunion côté Microsoft Graph
 * (organisateur = commercial connecté) puis l'enregistre. N'envoie rien au
 * prospect : c'est au commercial de transmettre le lien (cf. joinUrl
 * retourné), par le canal de son choix.
 */
crmMeetingRouter.post(
  "/crmMeeting/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    if (!graphConfigured()) throw new HttpError(503, "Microsoft Graph non configuré — voir docs/microsoft-graph-teams-meetings.md");
    const b = req.body as CreateBody;
    if (!b.prospectId) throw new HttpError(400, "prospectId requis");
    if (!b.subject || !b.subject.trim()) throw new HttpError(400, "Objet de la réunion requis");
    const start = new Date(b.startDateTime);
    const end = new Date(b.endDateTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) throw new HttpError(400, "Dates de réunion invalides");

    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId } });
    if (!prospect) throw new HttpError(404, "Prospect introuvable");

    const organizerEmail = req.admin!.email;
    const organizerUserId = await resolveGraphUserId(organizerEmail);
    const meeting = await createOnlineMeeting({ organizerUserId, subject: b.subject.trim(), startDateTime: start, endDateTime: end });

    const row = await prisma.crmMeeting.create({
      data: {
        prospectId: b.prospectId,
        subject: b.subject.trim(),
        organizerEmail,
        startDateTime: start,
        endDateTime: end,
        joinUrl: meeting.joinWebUrl,
        graphMeetingId: meeting.id,
        graphOrganizerUserId: organizerUserId,
      },
    });
    res.status(201).json(shapeMeeting(row));
  })
);

/**
 * POST /wa/crmMeeting/fetchRecap — à déclencher manuellement après la
 * réunion (le transcript Microsoft met plusieurs minutes à être prêt, pas
 * de notification temps réel ici, cf. en-tête de lib/graphMeetings.ts).
 * Reprend le transcript le plus récent trouvé, génère résumé + points
 * d'action via Claude, et note l'enregistrement le plus récent s'il existe
 * (contenu jamais stocké en base, cf. route recording ci-dessous).
 */
crmMeetingRouter.post(
  "/crmMeeting/fetchRecap",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const row = await prisma.crmMeeting.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, "Réunion introuvable");

    try {
      const transcripts = await listTranscripts(row.graphOrganizerUserId, row.graphMeetingId);
      if (!transcripts.length) {
        await prisma.crmMeeting.update({ where: { id }, data: { status: "failed" } });
        throw new HttpError(409, "Aucun transcript disponible pour l'instant — le transcript Microsoft peut mettre plusieurs minutes à être prêt après la fin de la réunion, réessayez un peu plus tard. Vérifiez aussi que la transcription a bien été activée pendant la réunion.");
      }
      // Le plus récent (une réunion rouverte/redémarrée peut en produire
      // plusieurs) — createdDateTime le plus grand.
      const latest = transcripts.slice().sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime))[0];
      const transcriptText = await getTranscriptText(row.graphOrganizerUserId, row.graphMeetingId, latest.id);
      if (!transcriptText.trim()) throw new HttpError(409, "Transcript vide — rien à résumer.");

      const recap = await generateMeetingSummary(transcriptText);

      let recordingGraphId: string | null = row.recordingGraphId;
      try {
        const recordings = await listRecordings(row.graphOrganizerUserId, row.graphMeetingId);
        if (recordings.length) recordingGraphId = recordings.slice().sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime))[0].id;
      } catch (e) {
        // L'enregistrement est secondaire au compte-rendu — une erreur ici
        // (ex : enregistrement jamais démarré par l'organisateur) ne doit
        // jamais faire échouer la récupération du résumé/transcript.
        console.warn(`[crmMeeting] liste des enregistrements indisponible pour ${id}:`, e);
      }

      const updated = await prisma.crmMeeting.update({
        where: { id },
        data: {
          status: "fetched",
          transcriptText,
          summaryText: recap.summary,
          actionItems: recap.actionItems,
          recordingGraphId,
          fetchedAt: new Date(),
        },
      });
      res.json(shapeMeeting(updated));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      await prisma.crmMeeting.update({ where: { id }, data: { status: "failed" } }).catch(() => {});
      throw e;
    }
  })
);

/**
 * GET /wa/crmMeeting/:id/recording — proxy du flux vidéo Microsoft Graph,
 * jamais de jeton Graph exposé au navigateur ni de contenu stocké en base.
 */
crmMeetingRouter.get(
  "/crmMeeting/:id/recording",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const row = await prisma.crmMeeting.findUnique({ where: { id: req.params.id } });
    if (!row || !row.recordingGraphId) throw new HttpError(404, "Aucun enregistrement disponible pour cette réunion");
    const upstream = await getRecordingStream(row.graphOrganizerUserId, row.graphMeetingId, row.recordingGraphId);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (!upstream.body) {
      res.status(502).end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  })
);

/**
 * POST /wa/crmMeeting/sendSummaryEmail — envoie le résumé (modifiable avant
 * envoi côté client, le texte final est fourni dans le body plutôt que
 * relu depuis summaryText, pour ne jamais ré-enregistrer silencieusement
 * une édition de dernière minute comme la version "officielle") au contact
 * du prospect. Même boîte que les réponses ticket (Config SMTP portée CRM),
 * pas une identité d'expédition dédiée — à revoir si demandé séparément.
 */
crmMeetingRouter.post(
  "/crmMeeting/sendSummaryEmail",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { id: string; to: string; subject: string; body: string };
    const row = await prisma.crmMeeting.findUnique({ where: { id: b.id } });
    if (!row) throw new HttpError(404, "Réunion introuvable");
    if (!b.to || !b.to.trim()) throw new HttpError(400, "Destinataire requis");
    if (!b.body || !b.body.trim()) throw new HttpError(400, "Corps du message requis");

    const smtp = await getSmtpConfig(null);
    const html = b.body.replace(/\n/g, "<br>");
    await sendEmailRaw(null, b.to.trim(), b.subject?.trim() || `Compte-rendu : ${row.subject}`, html, smtp?.fromName || undefined, {});
    res.json({ ok: true });
  })
);
