/**
 * Planification automatique (§5.1, §5.2) : affecte chaque rencontre à un terrain et un créneau
 * en évitant les conflits de terrain, la présence simultanée d'un participant sur deux rencontres,
 * et en jouant une rencontre après celles dont elle dépend (tour précédent, fin de poule).
 */
export interface ScheduleItem {
  id: string;
  /** Participants connus (vides tant que la place n'est pas attribuée). */
  participants: string[];
  /** Rencontres devant être terminées avant celle-ci. */
  after: string[];
  /** Créneau imposé (rencontre déjà planifiée et verrouillée). */
  fixed?: { court: number; slot: number };
}

export interface ScheduleOptions {
  courts: number;
  /** Repos minimal en créneaux entre deux rencontres d'un même participant (0 = enchaînement possible). */
  restSlots?: number;
  /** Nombre maximal de créneaux (fin de journée) ; au-delà, la rencontre reste « à planifier ». */
  maxSlots?: number;
}

export interface ScheduleResult {
  placed: Map<string, { court: number; slot: number }>;
  unplaced: string[];
}

export function schedule(items: ScheduleItem[], opts: ScheduleOptions): ScheduleResult {
  const courts = Math.max(1, opts.courts);
  const rest = Math.max(0, opts.restSlots ?? 0);
  const maxSlots = opts.maxSlots ?? 10_000;
  const busyCourt = new Map<number, Set<number>>();    // créneau -> terrains occupés
  const lastSlot = new Map<string, number[]>();        // participant -> créneaux joués
  const placed = new Map<string, { court: number; slot: number }>();
  const unplaced: string[] = [];
  const take = (id: string, court: number, slot: number, parts: string[]) => {
    placed.set(id, { court, slot });
    if (!busyCourt.has(slot)) busyCourt.set(slot, new Set());
    busyCourt.get(slot)!.add(court);
    for (const p of parts) lastSlot.set(p, [...(lastSlot.get(p) ?? []), slot]);
  };
  for (const it of items) if (it.fixed) take(it.id, it.fixed.court, it.fixed.slot, it.participants);

  const byId = new Map(items.map((i) => [i.id, i]));
  for (const it of items) {
    if (it.fixed) continue;
    let earliest = 0, blocked = false;
    for (const dep of it.after) {
      const d = placed.get(dep);
      if (d) earliest = Math.max(earliest, d.slot + 1);
      else if (byId.has(dep)) { blocked = true; break; } // dépendance non planifiée
    }
    if (blocked) { unplaced.push(it.id); continue; }
    let done = false;
    for (let slot = earliest; slot < maxSlots && !done; slot++) {
      const conflict = it.participants.some((p) => (lastSlot.get(p) ?? []).some((s) => Math.abs(s - slot) <= rest));
      if (conflict) continue;
      const used = busyCourt.get(slot) ?? new Set<number>();
      for (let c = 1; c <= courts; c++) {
        if (!used.has(c)) { take(it.id, c, slot, it.participants); done = true; break; }
      }
    }
    if (!done) unplaced.push(it.id);
  }
  return { placed, unplaced };
}
