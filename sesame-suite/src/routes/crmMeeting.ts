import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { graphConfigured } from "../lib/graph";
import {
  resolveGraphUserId,
  createOnlineMeeting,
  listTranscripts,
  getTranscriptText,
  listRecordings,
  getRecordingStream,
  listCalendarMeetings,
  resolveOnlineMeetingId,
} from "../lib/graphMeetings";
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
  ccEmails?: string[];
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

    const ccEmails = Array.isArray(b.ccEmails) ? b.ccEmails.map((e) => (e || "").trim()).filter(Boolean) : [];

    const organizerEmail = req.admin!.email;
    const organizerUserId = await resolveGraphUserId(organizerEmail);
    const meeting = await createOnlineMeeting({
      organizerUserId,
      subject: b.subject.trim(),
      startDateTime: start,
      endDateTime: end,
      attendeeEmail: prospect.email || undefined,
      attendeeName: prospect.nom,
      ccEmails,
    });

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

/**
 * POST /wa/crmMeeting/syncHistory — rattache rétroactivement aux fiches
 * prospects les réunions Teams déjà planifiées/tenues (24/10/2026 puis
 * demande complémentaire 27/10/2026) : parcourt le calendrier de chaque
 * commercial (AdminUser role="sesame" actif) sur 90 jours en arrière à 180
 * jours en avant, matche par email de participant (fiche OU contact), crée
 * un CrmMeeting pour chaque réunion non encore connue (dédupliquée par
 * joinUrl, globalement unique côté Teams). Le transcript/enregistrement des
 * réunions anciennes peut avoir expiré côté Microsoft (rétention limitée,
 * souvent 60-90 jours) — seule la réunion elle-même est garantie récupérable,
 * "Récupérer le compte-rendu" reste ensuite une action manuelle par fiche.
 */
crmMeetingRouter.post(
  "/crmMeeting/syncHistory",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    if (!graphConfigured()) throw new HttpError(503, "Microsoft Graph non configuré — voir docs/microsoft-graph-teams-meetings.md");

    const admins = await prisma.adminUser.findMany({ where: { role: "sesame", active: true }, select: { email: true } });
    const [prospects, contacts, existing] = await Promise.all([
      prisma.crmProspect.findMany({ where: { email: { not: null } }, select: { id: true, email: true } }),
      prisma.crmContact.findMany({ where: { email: { not: null } }, select: { prospectId: true, email: true } }),
      prisma.crmMeeting.findMany({ select: { joinUrl: true } }),
    ]);

    const emailToProspectId = new Map<string, string>();
    for (const p of prospects) if (p.email) emailToProspectId.set(p.email.toLowerCase(), p.id);
    for (const c of contacts) if (c.email) emailToProspectId.set(c.email.toLowerCase(), c.prospectId);
    const knownJoinUrls = new Set(existing.map((m) => m.joinUrl));

    const now = Date.now();
    const startISO = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const endISO = new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString();

    let scanned = 0;
    let created = 0;
    let skipped = 0; // réunions personnelles (teams.live.com) ou déjà tentées dans ce run — jamais résolvables, pas remontées en erreur
    const errorCounts = new Map<string, number>();
    const pushError = (msg: string) => errorCounts.set(msg, (errorCounts.get(msg) || 0) + 1);
    // Une réunion récurrente produit une instance par occurrence dans calendarView,
    // toutes avec le MÊME joinUrl — on ne tente la résolution Graph qu'une fois par
    // joinUrl et par run, pour ne pas spammer l'API (et les erreurs) N fois pour le
    // même résultat.
    const attemptedJoinUrls = new Set<string>();
    // Échantillon des réunions "enterprise" (pas perso, pas déjà connues) dont
    // aucun participant ne matche un email CRM — sert à diagnostiquer un
    // écart d'adresse email plutôt que de laisser l'absence de résultat
    // inexpliquée (demande client 27/10/2026, "ne ramène rien").
    const unmatchedSample: { subject: string; startDateTime: string; attendeeEmails: string[] }[] = [];
    const UNMATCHED_SAMPLE_LIMIT = 20;

    for (const admin of admins) {
      let organizerUserId: string;
      try {
        organizerUserId = await resolveGraphUserId(admin.email);
      } catch (e) {
        pushError(`${admin.email} : ${e instanceof Error ? e.message : "erreur Graph"}`);
        continue;
      }

      let events;
      try {
        events = await listCalendarMeetings(organizerUserId, startISO, endISO);
      } catch (e) {
        pushError(`${admin.email} : échec lecture calendrier (${e instanceof Error ? e.message : "erreur Graph"})`);
        continue;
      }
      scanned += events.length;

      for (const ev of events) {
        if (knownJoinUrls.has(ev.joinUrl)) continue;
        // teams.live.com = Teams "grand public" (compte personnel), jamais
        // résolvable via /onlineMeetings côté tenant — pas une erreur, juste
        // hors périmètre.
        if (/teams\.live\.com/i.test(ev.joinUrl)) { skipped++; continue; }
        const matchedProspectId = ev.attendeeEmails.map((e) => emailToProspectId.get(e)).find(Boolean);
        if (!matchedProspectId) {
          if (unmatchedSample.length < UNMATCHED_SAMPLE_LIMIT) {
            unmatchedSample.push({ subject: ev.subject, startDateTime: ev.startDateTime, attendeeEmails: ev.attendeeEmails });
          }
          continue;
        }

        if (attemptedJoinUrls.has(ev.joinUrl)) { skipped++; continue; }
        attemptedJoinUrls.add(ev.joinUrl);

        let meetingId: string | null = null;
        try {
          meetingId = await resolveOnlineMeetingId(organizerUserId, ev.joinUrl);
        } catch (e) {
          pushError(`${ev.subject} : échec résolution réunion (${e instanceof Error ? e.message : "erreur Graph"})`);
          continue;
        }
        if (!meetingId) continue;

        await prisma.crmMeeting.create({
          data: {
            prospectId: matchedProspectId,
            subject: ev.subject,
            organizerEmail: admin.email,
            startDateTime: new Date(ev.startDateTime),
            endDateTime: new Date(ev.endDateTime),
            joinUrl: ev.joinUrl,
            graphMeetingId: meetingId,
            graphOrganizerUserId: organizerUserId,
          },
        });
        knownJoinUrls.add(ev.joinUrl);
        created++;
      }
    }

    const errors = [...errorCounts.entries()].map(([msg, count]) => (count > 1 ? `${msg} (×${count})` : msg));
    res.json({ created, scanned, skipped, organizers: admins.length, errors, unmatchedSample });
  })
);
