/**
 * Offres et quotas (§23) : définis à un seul endroit, activables sans commercialisation dès le MVP.
 * La variable DEFAULT_PLAN permet d'ouvrir toutes les fonctions pendant la phase pilote.
 */
export type PlanKey = 'free' | 'club' | 'pro';
export type Feature = 'referees' | 'exports' | 'branding' | 'statistics' | 'multi_organizers' | 'api';

export const PLANS: Record<PlanKey, { label: string; maxParticipants: number; activeTournaments: number | null; features: Feature[] }> = {
  free: { label: 'Gratuit', maxParticipants: 32, activeTournaments: 3, features: ['referees'] },
  club: { label: 'Club', maxParticipants: 256, activeTournaments: null, features: ['referees', 'exports', 'branding', 'statistics', 'multi_organizers'] },
  pro: { label: 'Organisateur Pro', maxParticipants: 2000, activeTournaments: null, features: ['referees', 'exports', 'branding', 'statistics', 'multi_organizers', 'api'] },
};
export const planOf = (p: string | undefined): (typeof PLANS)[PlanKey] => PLANS[(p as PlanKey) in PLANS ? (p as PlanKey) : 'free'];
export const hasFeature = (plan: string, f: Feature) => planOf(plan).features.includes(f);
