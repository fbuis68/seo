import { z } from 'zod';

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

/** Montant décimal transmis en chaîne ("1234.50") : jamais de float pour la finance. */
export const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Montant décimal attendu (ex. 1250.00)');
export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ attendue');
export const siret = z.string().regex(/^\d{14}$/, 'SIRET à 14 chiffres');

/** Clé de contrôle (Luhn ; exception La Poste). */
export function siretChecksumOk(s: string): boolean {
  if (!/^\d{14}$/.test(s)) return false;
  if (s.startsWith('356000000')) return s.split('').reduce((a, c) => a + Number(c), 0) % 5 === 0;
  let sum = 0;
  for (let i = 0; i < 14; i++) { let d = Number(s[13 - i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}
/** SIRET de l'organisme : obligatoire, espaces tolérés, 14 chiffres et clé de contrôle valide. */
export const siretRequired = z.string({ error: 'SIRET obligatoire' }).transform((v) => v.replace(/[\s.]/g, ''))
  .refine((v) => v.length > 0, 'SIRET obligatoire')
  .refine((v) => /^\d{14}$/.test(v), 'Le SIRET comporte 14 chiffres')
  .refine(siretChecksumOk, 'SIRET invalide : vérifiez les chiffres (clé de contrôle)');

/** Pagination standard. */
export const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
});
