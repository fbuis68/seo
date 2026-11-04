import { graphFetch } from "./graph";

/**
 * Synchronisation des tâches CRM (CrmActivity) vers le calendrier Outlook
 * du commercial assigné (04/11/2026, demande client "écriture des tâches
 * dans Outlook... dans le calendrier de chaque utilisateur") — même
 * permission d'application Microsoft Graph que les réunions Teams
 * (Calendars.ReadWrite, cf. lib/graphMeetings.ts), rien de nouveau à
 * consentir côté Azure. Toujours appelé en best-effort depuis
 * routes/crmProspect.ts (try/catch, jamais bloquant pour la tâche
 * elle-même si Graph est indisponible ou mal configuré) — ce module ne
 * fait QUE l'appel Graph, aucune lecture/écriture en base ici.
 *
 * Événement TOUTE LA JOURNÉE sur la date d'échéance (CrmActivity n'a
 * jamais d'heure précise, jamais inventée) plutôt qu'un créneau horaire —
 * une tâche n'est pas un rendez-vous.
 */

export interface TaskEventInput {
  subject: string;
  date: Date;
  bodyHtml?: string;
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

// Graph exige un end > start pour un événement "toute la journée" — le
// jour suivant minuit, convention standard (borne de fin exclusive), pas
// la même date que le start.
function allDayRange(date: Date): { start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } } {
  return {
    start: { dateTime: `${isoDateOnly(date)}T00:00:00`, timeZone: "UTC" },
    end: { dateTime: `${isoDateOnly(addDays(date, 1))}T00:00:00`, timeZone: "UTC" },
  };
}

export async function createTaskEvent(userEmail: string, input: TaskEventInput): Promise<string> {
  const event = (await graphFetch(`/users/${encodeURIComponent(userEmail)}/events`, {
    method: "POST",
    body: JSON.stringify({
      subject: input.subject,
      isAllDay: true,
      ...allDayRange(input.date),
      ...(input.bodyHtml ? { body: { contentType: "HTML", content: input.bodyHtml } } : {}),
      categories: ["Tâche Sesame CRM"],
    }),
  })) as { id?: string };
  if (!event.id) throw new Error("Microsoft Graph n'a renvoyé aucun id d'événement");
  return event.id;
}

export async function updateTaskEvent(userEmail: string, eventId: string, input: Partial<TaskEventInput>): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.subject !== undefined) data.subject = input.subject;
  if (input.date !== undefined) Object.assign(data, allDayRange(input.date));
  if (input.bodyHtml !== undefined) data.body = { contentType: "HTML", content: input.bodyHtml };
  if (!Object.keys(data).length) return;
  await graphFetch(`/users/${encodeURIComponent(userEmail)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteTaskEvent(userEmail: string, eventId: string): Promise<void> {
  // 404 = déjà supprimé côté Outlook (manuellement, ou boîte désactivée) —
  // pas une erreur à remonter, la tâche CRM doit pouvoir continuer sa vie.
  try {
    await graphFetch(`/users/${encodeURIComponent(userEmail)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof Error) || !/\s404\s/.test(e.message)) throw e;
  }
}
