import { z } from 'zod';

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

/** Montant décimal transmis en chaîne ("1234.50") : jamais de float pour la finance. */
export const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Montant décimal attendu (ex. 1250.00)');
export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ attendue');
export const siret = z.string().regex(/^\d{14}$/, 'SIRET à 14 chiffres');

/** Pagination standard. */
export const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
});
