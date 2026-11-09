/**
 * Lists for `x IN (…)` with every value a bound parameter (review
 * RUNAPI-16 / ADM1-10 / ADM2-03, 2026-11-09).
 *
 * The purges and two price lookups spliced `'${id}'` into `sql.raw`,
 * which CONTRIBUTING forbids: the ids were database uuids, but some came
 * from a JSON column, and the pattern is one change away from an
 * injection. A value that is not a uuid now fails the cast instead of
 * becoming SQL.
 *
 * For `IN` only. An empty list is `(NULL)`, which no value is in; under
 * `NOT IN` it would exclude every row, so a caller that negates must
 * handle the empty case itself.
 */
import { sql, type SQL } from 'drizzle-orm';

/** `(…)` of uuid parameters, for a uuid column. */
export function inUuids(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`(NULL::uuid)`;
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/** `(…)` of text parameters, for a text expression such as `payload->>'runId'`. */
export function inTexts(values: readonly string[]): SQL {
  if (values.length === 0) return sql`(NULL::text)`;
  return sql`(${sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  )})`;
}
