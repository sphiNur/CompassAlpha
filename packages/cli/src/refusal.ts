/**
 * A refusal: the command stops without writing anything. index.ts prints
 * the message in red, without a stack trace, and exits with code 1.
 */
export class Refusal extends Error {}

/** The largest value of a Postgres bigint (auth.users.tg_user_id). */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * A Telegram user id typed on the command line: a positive whole number
 * that fits auth.users.tg_user_id. Anything else is refused before any
 * query runs.
 */
export function parseTgUserId(raw: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > BIGINT_MAX) {
    throw new Refusal(`Not a Telegram user id: ${raw}`);
  }
  return BigInt(raw);
}
