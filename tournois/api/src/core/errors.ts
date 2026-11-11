import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ZodError } from 'zod';
import { ScoreError } from '../engine/scoring';

/** Erreur métier structurée : {code, message, field, details, trace_id}. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public details?: unknown) { super(message); }
}
export const badRequest = (code: string, message: string, field?: string) => new AppError(400, code, message, field);
export const unauthorized = () => new AppError(401, 'unauthenticated', 'Authentification requise');
export const forbidden = (code = 'forbidden', message = 'Action non autorisée') => new AppError(403, code, message);
export const notFound = (what = 'Ressource') => new AppError(404, 'not_found', `${what} introuvable`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, undefined, details);
export const paymentRequired = (code: string, message: string) => new AppError(402, code, message);

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const trace_id = randomUUID();
    let status = 500, code = 'internal_error', message = 'Erreur interne', field: string | undefined, details: unknown;
    if (err instanceof AppError) ({ status, code, message, field, details } = err);
    else if (err instanceof ScoreError) { status = 422; code = 'invalid_score'; message = err.message; field = err.field; }
    else if (err instanceof ZodError) {
      status = 400; code = 'validation_error';
      const first = err.issues[0];
      message = first?.message ?? 'Requête invalide';
      field = first?.path.join('.');
      details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    } else if (err instanceof HttpException) { status = err.getStatus(); code = 'http_error'; message = err.message; }
    else if (err?.code === '23505') { status = 409; code = 'duplicate'; message = 'Doublon : enregistrement déjà existant.'; }
    else if (err?.code === '23503') { status = 409; code = 'reference_error'; message = 'Référence invalide ou utilisée.'; }
    else if (err?.code === '40001' || err?.code === '40P01') { status = 409; code = 'concurrent_update'; message = 'Modification concurrente : réessayez.'; }
    if (status >= 500) console.error(`[${trace_id}]`, err);
    if (!res.headersSent) res.status(status).json({ code, message, field, details, trace_id });
  }
}
