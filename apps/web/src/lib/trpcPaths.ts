/**
 * The API's procedure names as types, read from the tRPC client (the web
 * has no @trpc/server dependency, so the router's own path types are out
 * of reach). Review COREWEB2-29 (2026-11-12): the hand-written lists of
 * procedure names (the outbox's, the saved query cache's) were plain
 * strings, so a renamed procedure showed up only at run time.
 */
import type { trpc } from './trpc';

type Client = ReturnType<typeof trpc.useUtils>['client'];

/** The client entry for `router.procedure`; never for a name the API lacks. */
export type ClientProcedure<P extends string> = P extends `${infer R}.${infer N}`
  ? R extends keyof Client
    ? N extends keyof Client[R]
      ? Client[R][N]
      : never
    : never
  : never;

/** Every query of the API, as `router.procedure`. */
export type QueryPath = {
  [R in keyof Client & string]: {
    [N in keyof Client[R] & string]: Client[R][N] extends { query: unknown } ? `${R}.${N}` : never;
  }[keyof Client[R] & string];
}[keyof Client & string];

/**
 * The input a mutation of the API takes, as `router.procedure`; never for
 * a name that is not a mutation of the API.
 */
export type MutationInput<P extends string> = [ClientProcedure<P>] extends [never]
  ? never
  : ClientProcedure<P> extends { mutate: (input: infer I, ...rest: never[]) => unknown }
    ? I
    : never;
