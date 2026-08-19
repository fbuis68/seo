/**
 * Fuseau horaire de l'établissement (EntityModuleConfig.timezone) — pour
 * toute logique métier qui doit raisonner sur "le jour actuel à l'hôtel"
 * plutôt que sur l'heure du serveur (souvent UTC en production) : moteur
 * d'automatisation (délais avant/après séjour), et tout ce qui affiche
 * "aujourd'hui" côté client (arrivées du jour, KPI, planning ménage) via
 * l'équivalent JS de ces fonctions dans public/*.html.
 */

const DEFAULT_TZ = "Europe/Paris";

/** Composants calendaires d'un instant, tels que vus dans le fuseau donné. */
function partsInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour === 24 ? 0 : +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
  };
}

/** Date du jour à l'hôtel, format "YYYY-MM-DD" — équivalent tz-aware de `new Date().toISOString().slice(0,10)`. */
export function todayInTz(timeZone: string = DEFAULT_TZ, at: Date = new Date()): string {
  const { year, month, day } = partsInTz(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Heure locale (0-23) à l'hôtel, pour les règles d'automatisation programmées à une heure donnée. */
export function hourInTz(timeZone: string = DEFAULT_TZ, at: Date = new Date()): number {
  return partsInTz(at, timeZone).hour;
}

/** Jour de la semaine (0=dimanche…6=samedi) à l'hôtel. */
export function weekdayInTz(timeZone: string = DEFAULT_TZ, at: Date = new Date()): number {
  const { year, month, day } = partsInTz(at, timeZone);
  // Construit un instant UTC à partir des composants locaux uniquement pour en lire le jour de semaine
  // (le jour de semaine calendaire ne dépend pas du fuseau du Date construit, seulement de y/m/d).
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Quantième du mois (1-31) à l'hôtel. */
export function dayOfMonthInTz(timeZone: string = DEFAULT_TZ, at: Date = new Date()): number {
  return partsInTz(at, timeZone).day;
}
