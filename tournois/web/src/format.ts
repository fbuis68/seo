const TZ = 'Europe/Paris';
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }) : '');
export const fmtTime = (d?: string | null) => (d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '');
export const fmtDateTime = (d?: string | null) => (d ? `${fmtDate(d)} ${fmtTime(d)}` : '');

export function scoreText(score: any): string {
  if (!score) return '';
  if (score.sets) return score.sets.map((s: any) => `${s.home}-${s.away}`).join(' ') + (score.retired ? ' ab.' : '');
  if (score.home !== undefined) return `${score.home} - ${score.away}`;
  return '';
}

export const MODE_LABELS: Record<string, string> = { single: 'Individuel', double: 'Double', team: 'Équipes' };
export const FORMAT_LABELS: Record<string, string> = { groups: 'Poules', league: 'Championnat', knockout: 'Élimination directe', groups_knockout: 'Poules + tableau final' };
export const T_STATUS: Record<string, string> = { draft: 'Brouillon', registration: 'Inscriptions', running: 'En cours', finished: 'Terminé', archived: 'Archivé' };
export const P_STATUS: Record<string, string> = { pending: 'À valider', confirmed: 'Confirmé', waitlist: 'Liste d’attente', refused: 'Refusé', withdrawn: 'Désisté', forfeit: 'Forfait' };
export const statusTone = (s: string) =>
  ({ completed: 'ok', walkover: 'muted', bye: 'muted', in_progress: 'live', called: 'live', awaiting_confirmation: 'warn', disputed: 'bad', postponed: 'warn', cancelled: 'muted' } as Record<string, string>)[s] ?? '';
