import { z } from 'zod';
import { DISCIPLINE_PRESETS } from '../../engine/scoring';

const setRule = z.object({
  kind: z.enum(['games', 'points']),
  target: z.number().int().min(1).max(100),
  winBy: z.number().int().min(1).max(5).optional(),
  cap: z.number().int().min(1).max(200).optional(),
  tiebreak: z.boolean().optional(),
});

export const ScoringSchema = z.object({
  mode: z.enum(['sets', 'points']),
  setsToWin: z.number().int().min(1).max(5).optional(),
  set: setRule.optional(),
  superTiebreak: z.boolean().optional(),
  superTiebreakPoints: z.number().int().min(5).max(21).optional(),
  decidingSet: setRule.optional(),
  drawAllowed: z.boolean().optional(),
  pointsTarget: z.number().int().min(1).max(500).optional(),
  walkover: z.object({ sets: z.array(z.tuple([z.number().int(), z.number().int()])).optional(), points: z.tuple([z.number().int(), z.number().int()]).optional() }).optional(),
});

export const RankingRulesSchema = z.object({
  points: z.object({ win: z.number().int(), draw: z.number().int(), loss: z.number().int(), forfeitLoss: z.number().int() }).optional(),
  tiebreakers: z.array(z.enum(['points', 'wins', 'head_to_head', 'set_diff', 'game_diff', 'sets_won', 'games_won', 'seed'])).max(8).optional(),
});

export const FormatConfigSchema = z.object({
  groups: z.object({
    count: z.number().int().min(1).max(64),
    distribution: z.enum(['snake', 'random', 'seeded']).default('snake'),
    legs: z.number().int().min(1).max(2).default(1),
    qualifiers: z.number().int().min(1).max(16).default(2),
    avoidSameGroup: z.boolean().default(true),
  }).optional(),
  league: z.object({ legs: z.number().int().min(1).max(2).default(1) }).optional(),
  knockout: z.object({
    thirdPlace: z.boolean().default(false),
    seeding: z.enum(['seeded', 'random']).default('seeded'),
  }).optional(),
});

export const RegistrationSchema = z.object({
  open: z.boolean().default(true),
  requireApproval: z.boolean().default(false),
  collectEmail: z.enum(['required', 'optional', 'hidden']).default('optional'),
  collectPhone: z.enum(['required', 'optional', 'hidden']).default('optional'),
  categories: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  closesAt: z.string().datetime({ offset: true }).optional(),
});

const iso = z.string().datetime({ offset: true, error: 'Date et heure ISO attendues' });

export const TournamentSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(2, 'Nom du tournoi requis').max(120),
  discipline: z.string().refine((d) => d in DISCIPLINE_PRESETS, 'Discipline inconnue'),
  startsAt: iso,
  endsAt: iso.optional(),
  venueName: z.string().trim().max(200).optional(),
  maxParticipants: z.number().int().min(2).max(2000),
  mode: z.enum(['single', 'double', 'team']),
  format: z.enum(['groups', 'league', 'knockout', 'groups_knockout']),
  formatConfig: FormatConfigSchema.default({}),
  scoring: ScoringSchema.optional(),
  rankingRules: RankingRulesSchema.default({}),
  courts: z.number().int().min(1).max(200).default(1),
  matchMinutes: z.number().int().min(5).max(600).optional(),
  breakMinutes: z.number().int().min(0).max(120).default(5),
  visibility: z.enum(['public', 'private']).default('public'),
  registration: RegistrationSchema.default({} as any),
  refereeMode: z.enum(['none', 'optional', 'required']).default('none'),
  refereeOfficial: z.boolean().default(true),
  confirmationHours: z.number().int().min(0).max(168).default(2),
  autoConfirmOnTimeout: z.boolean().default(false),
  branding: z.object({
    logoUrl: z.string().url().max(500).optional(),
    posterUrl: z.string().url().max(500).optional(),
    primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  }).default({}),
});
export type TournamentInput = z.infer<typeof TournamentSchema>;

const PartialTournament = TournamentSchema.omit({ orgId: true }).partial();
/** Modification partielle : sans valeurs par défaut (un champ absent n'est jamais réinitialisé). */
export const TournamentPatchSchema = z.object(Object.fromEntries(Object.entries(TournamentSchema.shape)
  .filter(([k]) => k !== 'orgId')
  .map(([k, v]) => [k, (v instanceof z.ZodDefault ? (v as any).unwrap() : v).optional()]))) as unknown as typeof PartialTournament;

const member = z.object({
  firstName: z.string().trim().min(1, 'Prénom requis').max(80),
  lastName: z.string().trim().min(1, 'Nom requis').max(80),
  email: z.string().trim().toLowerCase().email('Email invalide').max(200).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().max(30).optional().or(z.literal('').transform(() => undefined)),
  isCaptain: z.boolean().optional(),
});
export const ParticipantSchema = z.object({
  name: z.string().trim().max(120).optional(),   // pseudonyme ou nom d'équipe
  club: z.string().trim().max(120).optional(),
  category: z.string().trim().max(40).optional(),
  rating: z.number().min(-100000).max(100000).optional(),
  seed: z.number().int().min(1).max(2000).optional(),
  members: z.array(member).min(1).max(30),
  status: z.enum(['pending', 'confirmed', 'waitlist']).optional(),
});
export type ParticipantInput = z.infer<typeof ParticipantSchema>;

export const ScoreSchema = z.object({
  sets: z.array(z.object({ home: z.number().int().min(0).max(999), away: z.number().int().min(0).max(999) })).max(9).optional(),
  home: z.number().int().min(0).max(999).optional(),
  away: z.number().int().min(0).max(999).optional(),
  retired: z.enum(['home', 'away']).optional(),
});
