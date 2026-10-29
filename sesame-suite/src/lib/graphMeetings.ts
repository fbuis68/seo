import { graphFetch, graphFetchRaw } from "./graph";
import { HttpError } from "./asyncHandler";

/**
 * Réunions Teams créées depuis une fiche prospect (24/10/2026, demande
 * client) — même client Microsoft Graph "app-only" que lib/graph.ts (boîte
 * support), nouvelles permissions d'application requises côté Azure :
 * OnlineMeetings.ReadWrite.All, OnlineMeetingRecording.Read.All,
 * OnlineMeetingTranscript.Read.All, Calendars.ReadWrite (cf.
 * docs/microsoft-graph-teams-meetings.md pour la procédure de consentement
 * admin — ET l'Application Access Policy côté Teams PowerShell, requise en
 * plus du consentement API pour tout appel app-only "pour le compte d'un
 * utilisateur" sur /onlineMeetings).
 *
 * Point d'attention impératif (ne JAMAIS laisser croire le contraire côté
 * UI) : aucun appel ici ne peut forcer le démarrage automatique de
 * l'enregistrement — Microsoft gère ça via une politique de réunion Teams
 * réglée côté tenant (Teams Admin Center, hors de portée de l'API Graph
 * pour une réunion individuelle).
 *
 * La réunion est créée via un ÉVÉNEMENT DE CALENDRIER (POST .../events,
 * isOnlineMeeting + onlineMeetingProvider), pas via POST .../onlineMeetings
 * directement — seule façon d'obtenir à la fois : apparition dans le
 * calendrier Outlook de l'organisateur ET invitation envoyée par email aux
 * participants (un onlineMeeting "nu" ne fait ni l'un ni l'autre, découvert
 * en test réel le 26/10/2026). L'id de l'onlineMeeting sous-jacent (requis
 * pour transcripts/recordings) se résout ensuite par son joinUrl, méthode
 * documentée par Microsoft pour corréler un événement calendrier à sa
 * réunion Teams.
 */

export interface GraphOnlineMeeting {
  id: string;
  joinWebUrl: string;
}

/** Résout l'id utilisateur Graph (requis par les endpoints /onlineMeetings,
 * qui n'acceptent pas l'email dans tous les cas) à partir de son adresse —
 * l'organisateur doit être une vraie boîte Microsoft 365 du tenant. */
export async function resolveGraphUserId(email: string): Promise<string> {
  const user = (await graphFetch(`/users/${encodeURIComponent(email)}?$select=id`)) as { id?: string };
  if (!user.id) throw new HttpError(404, `Aucun utilisateur Microsoft 365 trouvé pour ${email} — l'organisateur doit avoir une vraie boîte dans ce tenant.`);
  return user.id;
}

export async function createOnlineMeeting(params: {
  organizerUserId: string;
  subject: string;
  startDateTime: Date;
  endDateTime: Date;
  attendeeEmail?: string;
  attendeeName?: string;
  ccEmails?: string[]; // invités en copie (type "optional" côté Graph) — pas le contact principal
}): Promise<GraphOnlineMeeting> {
  const attendees = [
    ...(params.attendeeEmail
      ? [{ emailAddress: { address: params.attendeeEmail, name: params.attendeeName || params.attendeeEmail }, type: "required" }]
      : []),
    ...(params.ccEmails || []).map((email) => ({ emailAddress: { address: email, name: email }, type: "optional" })),
  ];
  const event = (await graphFetch(`/users/${encodeURIComponent(params.organizerUserId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      subject: params.subject,
      start: { dateTime: params.startDateTime.toISOString(), timeZone: "UTC" },
      end: { dateTime: params.endDateTime.toISOString(), timeZone: "UTC" },
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      attendees,
    }),
  })) as { onlineMeeting?: { joinUrl?: string } };
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) throw new HttpError(502, "Réponse Microsoft Graph inattendue (événement créé sans lien de réunion Teams)");

  const meetingId = await resolveOnlineMeetingId(params.organizerUserId, joinUrl);
  if (!meetingId) throw new HttpError(502, "Réunion Teams créée mais introuvable via /onlineMeetings (délai de propagation Microsoft ?) — réessayez la planification.");

  return { id: meetingId, joinWebUrl: joinUrl };
}

/** Corrélation événement calendrier → onlineMeeting réel (nécessaire pour
 * transcripts/recordings, cf. en-tête de fichier) — méthode documentée par
 * Microsoft, aucune réponse de création/lecture d'événement ne porte l'id de
 * l'onlineMeeting directement. Réutilisé par createOnlineMeeting ET par la
 * synchronisation d'historique (routes/crmMeeting.ts syncHistory). */
export async function resolveOnlineMeetingId(organizerUserId: string, joinUrl: string): Promise<string | null> {
  const lookup = (await graphFetch(
    `/users/${encodeURIComponent(organizerUserId)}/onlineMeetings?$filter=JoinWebUrl eq '${encodeURIComponent(joinUrl)}'`
  )) as { value?: { id?: string }[] };
  return lookup.value?.[0]?.id || null;
}

/**
 * Extrait l'id Azure AD (Oid) du VRAI organisateur depuis le joinUrl Teams
 * (paramètre `context`, JSON encodé en query string : {"Tid":...,"Oid":...})
 * — cf. syncHistory (routes/crmMeeting.ts) : une réunion peut apparaître sur
 * le calendrier d'un commercial Sesame qui n'en est PAS l'organisateur (ex :
 * invité/CC), auquel cas interroger /onlineMeetings sur SA boîte échoue avec
 * "3004: Specified meeting is not found" — Graph n'autorise cette résolution
 * que depuis la boîte de l'organisateur réel, jamais un simple participant.
 * Cas réel confirmé le 29/10/2026 (Oid du lien ≠ id de la boîte scannée).
 */
export function extractOidFromJoinUrl(joinUrl: string): string | null {
  try {
    const context = new URL(joinUrl).searchParams.get("context");
    if (!context) return null;
    const parsed = JSON.parse(context) as { Oid?: string };
    return parsed.Oid || null;
  } catch {
    return null;
  }
}

export interface GraphCalendarMeeting {
  subject: string;
  startDateTime: string; // ISO UTC
  endDateTime: string; // ISO UTC
  joinUrl: string;
  attendeeEmails: string[];
  // Emails trouvés dans le corps de l'événement (pas dans les participants
  // Teams) — cas réel observé 27/10/2026 : un outil de prise de RDV externe
  // crée l'événement avec le commercial comme SEUL participant Teams et les
  // coordonnées du client (nom, email, tél.) en texte libre dans le corps
  // ("Rendez Vous Sesame - <nom client>", organisateur "Sesame Technology").
  // Sans ce champ, ces réunions ne matchaient jamais aucun prospect.
  bodyEmails: string[];
}

export interface DroppedCalendarEvent {
  subject: string;
  startDateTime: string;
  isOnlineMeeting: boolean;
  bodyEmails: string[];
  bodySnippet: string;
}

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Lien Teams brut dans le corps HTML de l'événement — repli pour les
// événements créés par un outil externe (ex : outil de prise de RDV en ligne)
// qui pose un vrai lien Teams dans le corps/la localisation sans renseigner
// isOnlineMeeting/onlineMeeting côté Graph (cas réel 27/10/2026 : le bouton
// "Rejoindre" et le lien apparaissaient dans Outlook, mais isOnlineMeeting
// restait false pour l'app Graph — l'événement disparaissait silencieusement
// du filtre ci-dessous, sans jamais atteindre le matching participant/corps).
const TEAMS_LINK_REGEX = /https:\/\/teams\.(?:microsoft\.com\/l\/meetup-join|live\.com\/meet)\/[^\s"'<>]+/i;
const decodeHtmlEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Liste les événements de calendrier Teams (isOnlineMeeting) d'un
 * organisateur sur une période donnée — utilisé pour la synchronisation
 * d'historique (rattacher rétroactivement des réunions déjà tenues aux
 * fiches prospects, cf. syncHistory). Pas de $filter côté serveur sur
 * isOnlineMeeting (support inégal selon les tenants) : filtré ici. */
type GraphCalendarEvent = {
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string };
  attendees?: { emailAddress?: { address?: string } }[];
  body?: { content?: string };
};

/**
 * Pagine via @odata.nextLink (29/10/2026) — une boîte partagée très
 * sollicitée (ex : mailbox d'un outil de prise de RDV externe) dépasse
 * largement 250 événements sur une fenêtre de 270 jours (-90/+180) ; sans
 * suivre la pagination, tout ce qui est au-delà de la 1ère page disparaissait
 * silencieusement — aucune erreur, aucun échantillon, juste absent (cas
 * réel confirmé 29/10/2026 : réunion introuvable nulle part dans le rapport
 * alors que la fiche prospect avait le bon email). nextLink est une URL
 * ABSOLUE Microsoft — on retire le préfixe GRAPH_BASE pour la repasser à
 * graphFetch (qui attend un chemin relatif), garde-fou à 20 pages
 * (5000 événements) pour ne jamais boucler indéfiniment sur une réponse
 * malformée.
 */
async function fetchAllCalendarPages(firstPath: string): Promise<GraphCalendarEvent[]> {
  const events: GraphCalendarEvent[] = [];
  let path: string | null = firstPath;
  let pages = 0;
  while (path && pages < 20) {
    pages++;
    const res = (await graphFetch(path)) as { value?: GraphCalendarEvent[]; "@odata.nextLink"?: string };
    events.push(...(res.value || []));
    const nextLink = res["@odata.nextLink"];
    path = nextLink ? nextLink.replace("https://graph.microsoft.com/v1.0", "") : null;
  }
  return events;
}

export async function listCalendarMeetings(
  organizerUserId: string,
  startISO: string,
  endISO: string
): Promise<{ meetings: GraphCalendarMeeting[]; dropped: DroppedCalendarEvent[] }> {
  const allEvents = await fetchAllCalendarPages(
    `/users/${encodeURIComponent(organizerUserId)}/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&$select=subject,start,end,isOnlineMeeting,onlineMeeting,attendees,body&$top=250`
  );
  const asUtcIso = (dt?: string) => (dt ? new Date(dt.endsWith("Z") ? dt : dt + "Z").toISOString() : "");
  const meetings: GraphCalendarMeeting[] = [];
  const dropped: DroppedCalendarEvent[] = [];
  for (const e of allEvents) {
    const bodyContent = e.body?.content || "";
    const joinUrl = e.onlineMeeting?.joinUrl || (bodyContent.match(TEAMS_LINK_REGEX) ? decodeHtmlEntities(bodyContent.match(TEAMS_LINK_REGEX)![0]) : null);
    if (!joinUrl) {
      // Événement sans aucun lien Teams exploitable (ni onlineMeeting, ni
      // dans le corps) — gardé pour diagnostic (routes/crmMeeting.ts
      // syncHistory, "droppedSample") plutôt que de disparaître sans trace.
      dropped.push({
        subject: e.subject || "(sans objet)",
        startDateTime: asUtcIso(e.start?.dateTime),
        isOnlineMeeting: !!e.isOnlineMeeting,
        bodyEmails: [...bodyContent.matchAll(EMAIL_REGEX)].map((m) => m[0].toLowerCase()),
        bodySnippet: bodyContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
      });
      continue;
    }
    meetings.push({
      subject: e.subject || "(sans objet)",
      startDateTime: asUtcIso(e.start?.dateTime),
      endDateTime: asUtcIso(e.end?.dateTime),
      joinUrl,
      attendeeEmails: (e.attendees || []).map((a) => (a.emailAddress?.address || "").toLowerCase()).filter(Boolean),
      bodyEmails: [...bodyContent.matchAll(EMAIL_REGEX)].map((m) => m[0].toLowerCase()),
    });
  }
  return { meetings, dropped };
}

export interface GraphTranscript {
  id: string;
  createdDateTime: string;
}

export async function listTranscripts(organizerUserId: string, meetingId: string): Promise<GraphTranscript[]> {
  const res = (await graphFetch(`/users/${encodeURIComponent(organizerUserId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`)) as {
    value?: GraphTranscript[];
  };
  return res.value || [];
}

/** Contenu du transcript au format VTT (texte horodaté) — converti en texte
 * brut, lisible, pour l'envoi à Claude (cf. aiClaude.ts generateMeetingSummary). */
export async function getTranscriptText(organizerUserId: string, meetingId: string, transcriptId: string): Promise<string> {
  const res = await graphFetchRaw(
    `/users/${encodeURIComponent(organizerUserId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`
  );
  const vtt = await res.text();
  return vttToPlainText(vtt);
}

/** WEBVTT → texte brut : retire l'en-tête, les index de bloc et les
 * horodatages ("00:00:01.000 --> 00:00:03.500"), ne garde que le texte
 * parlé, une ligne par réplique — suffisant pour un résumé IA, inutile d'y
 * faire apparaître le minutage. */
function vttToPlainText(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => line.trim() && !/^WEBVTT/.test(line) && !/-->/i.test(line) && !/^\d+$/.test(line.trim()))
    .join("\n")
    .trim();
}

export interface GraphRecording {
  id: string;
  createdDateTime: string;
}

export async function listRecordings(organizerUserId: string, meetingId: string): Promise<GraphRecording[]> {
  const res = (await graphFetch(`/users/${encodeURIComponent(organizerUserId)}/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`)) as {
    value?: GraphRecording[];
  };
  return res.value || [];
}

/** Flux vidéo brut d'un enregistrement — jamais stocké en base (fichier
 * potentiellement volumineux), proxyé à la demande par routes/crmMeeting.ts
 * (le jeton Graph ne doit jamais atteindre le navigateur). */
export async function getRecordingStream(organizerUserId: string, meetingId: string, recordingId: string): Promise<Response> {
  return graphFetchRaw(
    `/users/${encodeURIComponent(organizerUserId)}/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}/content`
  );
}
