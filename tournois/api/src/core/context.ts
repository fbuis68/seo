import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export interface RequestContext {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  sessionId: string;
  isPlatformAdmin: boolean;
  ip?: string;
}
export const IS_PUBLIC = 'tn:public';
export const OPTIONAL_AUTH = 'tn:optional-auth';
/** Route publique (consultation, inscription). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route publique enrichie si l'utilisateur est connecté. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);
export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): RequestContext => ec.switchToHttp().getRequest().ctx);
export const MaybeCtx = createParamDecorator((_: unknown, ec: ExecutionContext): RequestContext | undefined => ec.switchToHttp().getRequest().ctx);
