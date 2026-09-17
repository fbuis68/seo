/**
 * Import ponctuel de l'historique Freshdesk dans le module Tickets, pour
 * alimenter la recherche de cas similaires de l'assistant support IA (§ LOT
 * 1, cf. docs/support-ia-lot1.md). Lit les fichiers XML de l'export complet
 * Freshdesk ("Exportations de compte" > Tickets) déposés dans un dossier
 * local, jamais commités (données clients réelles).
 *
 * Ce script ne fait AUCUN appel IA — il se contente de créer les tickets,
 * prospects et messages en base. Lancer ensuite
 * scripts/backfill-ticket-embeddings.ts pour indexer (embeddings) les
 * tickets importés Résolu/Fermé.
 *
 * Idempotent : chaque ticket importé est tagué `fd:<id freshdesk>` — un
 * ticket déjà présent (même id) est ignoré au prochain lancement, on peut
 * donc relancer sans risque de doublon si l'export est mis à jour.
 *
 * Usage :
 *   npx tsx scripts/import-freshdesk-tickets.ts <dossier-export>
 *   (défaut : ./freshdesk-export)
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import { PrismaClient } from "@prisma/client";
import { findOrCreateProspectByEmail, nextTicketNumber } from "../src/lib/ticketInbound";

const prisma = new PrismaClient();

const STATUS_MAP: Record<string, string> = {
  Resolved: "Résolu",
  Closed: "Fermé",
  Open: "En attente",
  Pending: "En cours",
  "Waiting on Customer": "Attente client",
};

const PRIORITY_MAP: Record<string, string> = {
  Low: "Basse",
  Medium: "Normale",
  High: "Haute",
  Urgent: "Urgente",
};

interface FdNote {
  body?: string;
  incoming?: boolean | string;
  private?: boolean | string;
  "created-at"?: string;
}

interface FdTicket {
  id?: number | string;
  subject?: string;
  description?: string;
  "description-html"?: string;
  "status-name"?: string;
  "priority-name"?: string;
  "created-at"?: string;
  "ticket-states"?: { "resolved-at"?: string; "closed-at"?: string };
  requester?: { name?: string; email?: string };
  "responder-name"?: string;
  notes?: { "helpdesk-note"?: FdNote | FdNote[] };
}

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Note auto-générée par Freshdesk à l'ouverture d'un ticket via le portail
 * (user_agent/referrer/portal_url) — sans intérêt pour la connaissance de
 * résolution, exclue pour ne pas polluer l'embedding. */
function isNoiseNote(body: string): boolean {
  const t = body.trim();
  return !t || /^user_agent:/i.test(t);
}

async function loadExistingFreshdeskIds(): Promise<Set<string>> {
  const rows = await prisma.crmTicket.findMany({ select: { tags: true } });
  const ids = new Set<string>();
  for (const r of rows) {
    const tags = (r.tags as string[]) || [];
    for (const tag of tags) {
      if (tag.startsWith("fd:")) ids.add(tag.slice(3));
    }
  }
  return ids;
}

async function importTicket(t: FdTicket): Promise<{ messages: number } | null> {
  const freshdeskId = String(t.id ?? "");
  if (!freshdeskId) return null;

  const subject = (t.subject || "").trim() || "(sans sujet)";
  const description = (t.description || "").trim() || (t["description-html"] ? stripHtml(t["description-html"]) : "");
  const statusName = t["status-name"] || "";
  const status = STATUS_MAP[statusName] || "Fermé";
  const priority = PRIORITY_MAP[t["priority-name"] || ""] || "Normale";
  const createdAt = t["created-at"] ? new Date(t["created-at"]) : new Date();
  const closedAtRaw = t["ticket-states"]?.["closed-at"] || t["ticket-states"]?.["resolved-at"];
  const closedAt = status === "Fermé" && closedAtRaw ? new Date(closedAtRaw) : null;

  const requesterEmail = (t.requester?.email || "").trim().toLowerCase();
  const requesterName = (t.requester?.name || "").trim();
  const responderName = (t["responder-name"] || "").trim() || "Support";
  if (!requesterEmail) return null; // pas de contact exploitable, rien à créer

  const prospect = await findOrCreateProspectByEmail(requesterEmail, requesterName);
  const number = await nextTicketNumber();

  const ticket = await prisma.crmTicket.create({
    data: {
      prospectId: prospect.id,
      number,
      subject,
      status,
      priority,
      contactEmail: requesterEmail,
      contactName: requesterName || null,
      tags: ["freshdesk-import", `fd:${freshdeskId}`],
      createdAt,
      closedAt,
    },
  });

  // Fil de discussion : description initiale, puis notes triées
  // chronologiquement (client=incoming, agent=reste — privé=note interne,
  // public=réponse envoyée, cf. lib/aiIndexing.ts qui déduit
  // resolutionSummary de la dernière réponse "reply" de l'agent).
  const notes = asArray(t.notes?.["helpdesk-note"])
    .filter((n) => n.body && !isNoiseNote(n.body))
    .sort((a, b) => new Date(a["created-at"] || 0).getTime() - new Date(b["created-at"] || 0).getTime());

  const messages: { authorType: string; authorName: string; kind: string; body: string; createdAt: Date }[] = [];

  const firstNoteBody = notes[0]?.body?.trim();
  if (description && description !== firstNoteBody) {
    messages.push({ authorType: "client", authorName: requesterName, kind: "reply", body: description, createdAt });
  }

  for (const n of notes) {
    const incoming = toBool(n.incoming);
    const priv = toBool(n.private);
    messages.push({
      authorType: incoming ? "client" : "agent",
      authorName: incoming ? requesterName : responderName,
      kind: priv ? "note" : "reply",
      body: (n.body || "").trim(),
      createdAt: n["created-at"] ? new Date(n["created-at"]) : createdAt,
    });
  }

  if (messages.length) {
    await prisma.crmTicketMessage.createMany({
      data: messages.map((m) => ({ ticketId: ticket.id, ...m, attachments: [] })),
    });
  }

  return { messages: messages.length };
}

async function main() {
  const dir = process.argv[2] || "./freshdesk-export";
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xml"));
  if (!files.length) throw new Error(`Aucun fichier .xml trouvé dans ${dir}`);
  console.log(`${files.length} fichier(s) XML trouvé(s) dans ${dir} : ${files.join(", ")}`);

  const existingIds = await loadExistingFreshdeskIds();
  console.log(`${existingIds.size} ticket(s) déjà importé(s) précédemment (ignorés).`);

  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

  let parsed = 0;
  let skippedExisting = 0;
  let imported = 0;
  let importedMessages = 0;
  const statusCounts: Record<string, number> = {};

  for (const file of files) {
    const xml = readFileSync(join(dir, file), "utf-8");
    const data = parser.parse(xml) as { "helpdesk-tickets"?: { "helpdesk-ticket"?: FdTicket | FdTicket[] } };
    const tickets = asArray(data["helpdesk-tickets"]?.["helpdesk-ticket"]);
    console.log(`${file} : ${tickets.length} ticket(s)`);

    for (const t of tickets) {
      parsed++;
      const freshdeskId = String(t.id ?? "");
      if (!freshdeskId || existingIds.has(freshdeskId)) {
        skippedExisting++;
        continue;
      }
      try {
        const result = await importTicket(t);
        if (result) {
          imported++;
          importedMessages += result.messages;
          existingIds.add(freshdeskId);
          const status = STATUS_MAP[t["status-name"] || ""] || "Fermé";
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
      } catch (e) {
        console.error(`Échec import ticket Freshdesk #${freshdeskId} :`, e);
      }
      if (imported % 100 === 0 && imported > 0) console.log(`  ${imported} importés…`);
    }
  }

  console.log("─".repeat(40));
  console.log(`Tickets Freshdesk analysés : ${parsed}`);
  console.log(`Déjà importés (ignorés)    : ${skippedExisting}`);
  console.log(`Nouveaux tickets importés  : ${imported}`);
  console.log(`Messages créés             : ${importedMessages}`);
  console.log("Répartition par statut :", statusCounts);
  console.log("─".repeat(40));
  console.log("Prochaine étape : npx tsx scripts/backfill-ticket-embeddings.ts (indexation sémantique).");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
