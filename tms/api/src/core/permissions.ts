/** Permissions fines (§4). Contrôlées côté serveur sur chaque action. */
export const PERMISSIONS = [
  'org.manage', 'billing.manage', 'users.manage', 'exports.full', 'imports.manage',
  'crm.read', 'crm.write', 'catalog.read', 'catalog.write', 'sessions.read', 'sessions.write',
  'attendance.write', 'documents.read', 'documents.write', 'quality.read', 'quality.write',
  'finance.read', 'finance.write', 'signatures.send', 'opendata.enrich',
  'ai.use', 'ai.configure', 'analytics.read',
  'bank.connect', 'bank.read', 'bank.reconcile',
  'mail.configure', 'mail.send', 'mail.receive', 'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'owner' | 'manager' | 'trainer' | 'learner' | 'support';

const MANAGER: Permission[] = [
  'crm.read', 'crm.write', 'catalog.read', 'catalog.write', 'sessions.read', 'sessions.write',
  'attendance.write', 'documents.read', 'documents.write', 'quality.read', 'quality.write',
  'finance.read', 'finance.write', 'signatures.send', 'opendata.enrich', 'ai.use', 'analytics.read',
  'bank.read', 'bank.reconcile', 'mail.send', 'mail.receive',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  manager: MANAGER, // aucun accès abonnement par défaut
  // Le formateur ne voit que ses sessions affectées (filtrage supplémentaire dans les services).
  trainer: ['sessions.read', 'attendance.write', 'documents.read'],
  learner: [],
  // Support éditeur : accès temporaire nominatif, lecture seule.
  support: ['crm.read', 'catalog.read', 'sessions.read', 'documents.read', 'quality.read', 'finance.read', 'analytics.read', 'audit.read'],
};

export function effectivePermissions(role: Role, extra: string[] = [], revoked: string[] = []): Set<Permission> {
  const set = new Set<Permission>([...ROLE_PERMISSIONS[role], ...(extra as Permission[])]);
  for (const r of revoked) set.delete(r as Permission);
  return set;
}

/** Rôles comptés comme "gestionnaires" dans les quotas d'offre (formateurs/apprenants exclus). */
export const MANAGER_ROLES: Role[] = ['owner', 'manager'];
