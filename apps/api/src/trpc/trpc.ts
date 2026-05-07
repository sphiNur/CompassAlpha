import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { DomainError } from '@compass/domain';
import type { RequestContext } from './context';

const t = initTRPC.context<RequestContext>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (cause instanceof DomainError) {
      return {
        ...shape,
        data: {
          ...shape.data,
          code: shape.data.code,
          domainCode: cause.code,
          i18nKey: cause.i18nKey,
          context: cause.context,
        },
      };
    }
    if (cause instanceof ZodError) {
      return {
        ...shape,
        data: {
          ...shape.data,
          i18nKey: 'common.errors.validation',
          fieldErrors: cause.flatten().fieldErrors,
        },
      };
    }
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/** Authenticated user required. */
export const authedProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.required' });
  }
  return opts.next({ ctx: { ...opts.ctx, session: opts.ctx.session } });
});

/**
 * Permission-checking procedure. Loads `storeIdField` (if given) from the
 * input and validates it belongs to ctx.orgId before invoking the handler.
 */
export function permissionProcedure(permissionKey: string) {
  return authedProcedure.use(async (opts) => {
    if (!opts.ctx.session.permissions.has(permissionKey)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `auth.errors.missingPermission:${permissionKey}`,
      });
    }
    return opts.next();
  });
}

/** Map DomainError → TRPCError so tRPC's transport layer translates correctly. */
export function rethrowDomainError(err: unknown): never {
  if (err instanceof DomainError) {
    const code: TRPCError['code'] =
      err.code === 'VALIDATION'
        ? 'BAD_REQUEST'
        : err.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : err.code === 'CONFLICT'
            ? 'CONFLICT'
            : err.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : err.code === 'PRECONDITION_FAILED'
                ? 'PRECONDITION_FAILED'
                : err.code === 'RATE_LIMITED'
                  ? 'TOO_MANY_REQUESTS'
                  : 'INTERNAL_SERVER_ERROR';
    throw new TRPCError({ code, message: err.i18nKey, cause: err });
  }
  throw err;
}
