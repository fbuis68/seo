import { graphFetch, graphFetchRaw } from "./graph";
import { HttpError } from "./asyncHandler";

/**
 * Réunions Teams créées depuis une fiche prospect (24/10/2026, demande
 * client) — même client Microsoft Graph "app-only" que lib/graph.ts (boîte
 * support), nouvelles permissions d'application requises côté Azure :
 * OnlineMeetings.ReadWrite.All, OnlineMeetingRecording.Read.All,
 * OnlineMeetingTranscript.Read.All (cf. docs/microsoft-graph-teams-meetings.md
 * pour la procédure de consentement admin).
 *
 * Point d'attention impératif (ne JAMAIS laisser croire le contraire côté
 * UI) : aucun appel ici ne peut forcer le démarrage automatique de
 * l'enregistrement — Microsoft gère ça via une politique de réunion Teams
 * réglée côté tenant (Teams Admin Center, hors de portée de l'API Graph
 * pour une réunion individuelle). `allowRecording` autorise seulement
 * l'enregistrement, il ne le déclenche pas.
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
}): Promise<GraphOnlineMeeting> {
  const meeting = (await graphFetch(`/users/${encodeURIComponent(params.organizerUserId)}/onlineMeetings`, {
    method: "POST",
    body: JSON.stringify({
      subject: params.subject,
      startDateTime: params.startDateTime.toISOString(),
      endDateTime: params.endDateTime.toISOString(),
      // Autorise l'enregistrement — ne le démarre jamais automatiquement,
      // cf. avertissement en tête de fichier.
      allowRecording: true,
      allowTranscription: true,
    }),
  })) as { id?: string; joinWebUrl?: string };
  if (!meeting.id || !meeting.joinWebUrl) throw new HttpError(502, "Réponse Microsoft Graph inattendue (réunion créée sans id ou sans lien de participation)");
  return { id: meeting.id, joinWebUrl: meeting.joinWebUrl };
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
