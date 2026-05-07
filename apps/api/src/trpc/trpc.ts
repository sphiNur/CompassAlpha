import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { DomainError } from '@compass/domain';
import type { RequestContext } from './context';
import { logger } from '../infra/log';

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

/**
 * Cross-cutting error logger (M1.9-extra P7, 2026-05-07). Audit found
 * that `admin.ts` and `auth.ts` had ZERO error logging — every failed
 * admin mutation was invisible in journalctl. Hoisting the catch into
 * the procedure factory means every router gets structured logging
 * for free, with consistent context shape.
 *
 * INTERNAL_SERVER_ERROR is logged at error level with the full stack;
 * client-fault errors (4xx-shape) are logged at warn level so they
 * don't drown the signal but are still searchable.
 */
const errorLogMiddleware = t.middleware(async (opts) => {
  try {
    return await opts.next();
  } catch (err) {
    const tErr = err instanceof TRPCError ? err : null;
    const code = tErr?.code ?? 'UNKNOWN';
    const message = tErr?.message ?? (err instanceof Error ? err.message : String(err));
    const isServerFault =
      !tErr ||
      code === 'INTERNAL_SERVER_ERROR' ||
      code === 'TIMEOUT';
    const log = isServerFault ? logger.error.bind(logger) : logger.warn.bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = opts.ctx as any;
    log(
      {
        path: opts.path,
        type: opts.type,
        code,
        message,
        traceId: ctx?.traceId,
        userId: ctx?.session?.userId,
        orgId: ctx?.session?.orgId,
        cause: tErr?.cause,
        ...(isServerFault && err instanceof Error ? { stack: err.stack } : {}),
      },
      `trpc.${opts.path} ${tErr?.code ?? 'threw'}`,
    );
    throw err;
  }
});

export const publicProcedure = t.procedure.use(errorLogMiddleware);

/** Authenticated user required. */
export const authedProcedure = t.procedure.use(errorLogMiddleware).use(async (opts) => {
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
      // M1.9-extra (P7): bare key + cause; no colon-suffix.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'auth.errors.missingPermission',
        cause: { missingPermission: permissionKey },
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
