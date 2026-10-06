import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ZodError } from 'zod';

/** Erreur métier structurée : {code, message, field, trace_id}. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, message: string, field?: string) => new AppError(400, code, message, field);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (what = 'resource') => new AppError(404, 'not_found', `${what} introuvable`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, undefined, details);
/** Quota de l'offre atteint ou fonctionnalité non incluse : 402 pour inciter à changer d'offre. */
export const paymentRequired = (code: string, message: string, details?: unknown) => new AppError(402, code, message, undefined, details);

const PG_MESSAGES: Record<string, [number, string, string]> = {
  invoice_immutable: [409, 'invoice_immutable', 'Facture émise non modifiable : utiliser un avoir.'],
  program_version_locked: [409, 'program_version_locked', 'Version de programme utilisée : créer une nouvelle version.'],
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const trace_id = randomUUID();
    let status = 500, code = 'internal_error', message = 'Erreur interne', field: string | undefined, details: unknown;
    if (err instanceof AppError) {
      ({ status, code, message, field, details } = err);
    } else if (err instanceof ZodError) {
      status = 400; code = 'validation_error';
      const first = err.issues[0];
      message = first?.message ?? 'Requête invalide';
      field = first?.path.join('.');
      details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    } else if (err instanceof HttpException) {
      status = err.getStatus(); code = 'http_error'; message = err.message;
    } else if (err?.code === '23505') {
      status = 409; code = 'duplicate'; message = 'Doublon : enregistrement déjà existant.';
    } else if (err?.code === 'P0001' && PG_MESSAGES[err.message]) {
      [status, code, message] = PG_MESSAGES[err.message];
    } else if (err?.code === '23503') {
      status = 409; code = 'reference_error'; message = 'Référence invalide ou utilisée.';
    }
    if (status >= 500) console.error(`[${trace_id}]`, err);
    res.status(status).json({ code, message, field, details, trace_id });
  }
}
