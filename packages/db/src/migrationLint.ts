/**
 * Migrations may not control the transaction (review DB-01, 2026-11-09).
 *
 * Drizzle's migrator applies every pending migration inside ONE transaction
 * (drizzle-orm pg-core/dialect.js). A file with its own COMMIT ends that
 * transaction early. The rest of the batch then runs statement by
 * statement: a failure leaves a migration half applied and unrecorded, and
 * a `set_config(..., true)` lasts for its own statement only, so a backfill
 * under FORCE RLS that followed it saw no rows, wrote nothing, and was
 * still recorded as applied.
 *
 * The files below were written before this rule and have shipped, so they
 * stay as they are. Never add to this list: the runner owns the
 * transaction, and it sets the system context for the whole session.
 */
export const LEGACY_TRANSACTION_CONTROL: ReadonlySet<string> = new Set([
  '0007_fanout_subadmin_role_bindings',
  '0009_store_default_role_and_audit_scope',
  '0010_session_notes',
  '0011_manager_users_manage',
  '0012_rls_missing_tables',
  '0019_align_inventory_rls',
  '0020_role_perm_realignment',
  '0021_backfill_dishes_manage_to_admins',
  '0022_org_admin_marker',
  '0023_sku_step_canonical',
  '0024_session_extras',
  '0025_session_previous_claimer',
  '0026_order_session_partial_unique',
  '0027_run_claim',
  '0028_org_tz_default',
  '0029_run_item_added_by_purchaser',
  '0030_run_expenses',
  '0031_user_secondary_locale',
  '0032_expense_templates',
  '0034_run_amend_permission',
  '0035_one_active_run_per_org',
  '0036_sku_unit_canonical',
  '0056_role_binding_unique',
]);

// A statement on its own line. PL/pgSQL's block `BEGIN` takes no semicolon
// and `END;` closes blocks inside DO bodies, so neither is matched.
const TRANSACTION_CONTROL =
  /^[ \t]*(?:BEGIN|START[ \t]+TRANSACTION|COMMIT|ROLLBACK|ABORT)(?:[ \t]+(?:WORK|TRANSACTION))?[ \t]*;/gim;

/** The transaction-control statements in one migration, as written. */
export function transactionControl(sql: string): string[] {
  return [...sql.matchAll(TRANSACTION_CONTROL)].map((m) => m[0].trim());
}

/** Migrations that control the transaction and are not on the legacy list. */
export function transactionControlViolations(
  files: ReadonlyArray<{ tag: string; sql: string }>,
): Array<{ tag: string; statements: string[] }> {
  return files.flatMap(({ tag, sql }) => {
    if (LEGACY_TRANSACTION_CONTROL.has(tag)) return [];
    const statements = transactionControl(sql);
    return statements.length > 0 ? [{ tag, statements }] : [];
  });
}

/** A `migrations/meta/_journal.json` entry, as far as these checks read it. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Review DB-07 (2026-11-10): the journal must stay in order.
 *
 * Drizzle applies an entry only when its `when` is later than the newest
 * migration the database has recorded (drizzle-orm 0.45, pg-core/dialect.js),
 * and says nothing about the entries it passes over. `when` is typed by hand
 * here: two branches merged within the hour can both take "the last one +
 * 1", and whichever deploys second is then skipped for good while the
 * deploy reports success.
 */
export function journalOrderProblems(entries: readonly JournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((entry, i) => {
    if (entry.idx !== i) problems.push(`${entry.tag}: idx is ${entry.idx}, expected ${i}`);
    const previous = entries[i - 1];
    if (previous && !(entry.when > previous.when)) {
      problems.push(
        `${entry.tag}: when ${entry.when} is not after ${previous.tag}'s ${previous.when}`,
      );
    }
  });
  return problems;
}

/**
 * The entries a database would never apply: dated no later than the
 * newest migration it recorded, and not recorded themselves. `recorded`
 * holds the `created_at` values of drizzle.__drizzle_migrations, which are
 * the `when` of each applied entry.
 */
export function unreachableMigrations(
  entries: readonly JournalEntry[],
  recorded: readonly number[],
): JournalEntry[] {
  if (recorded.length === 0) return [];
  const newest = Math.max(...recorded);
  const applied = new Set(recorded);
  return entries.filter((entry) => entry.when <= newest && !applied.has(entry.when));
}

/**
 * Review OPS-10 (2026-11): the entries the next run applies, chosen the
 * way drizzle chooses them: dated after the newest migration the database
 * recorded, or every entry when it recorded none.
 */
export function pendingMigrations(
  entries: readonly JournalEntry[],
  recorded: readonly number[],
): JournalEntry[] {
  if (recorded.length === 0) return [...entries];
  const newest = Math.max(...recorded);
  return entries.filter((entry) => entry.when > newest);
}

/**
 * Review DB-10 (2026-11-11): an index name belongs to one table.
 *
 * Index names are unique within a schema, and `CREATE INDEX IF NOT EXISTS`
 * with a name another table already uses is skipped without an error.
 * 0065 named the org index of inventory.attendance_punch_reviews
 * `apr_org_idx`, the name 0061 had given to attendance_pay_rates, so the
 * reviews table went without one until 0069.
 */
export const LEGACY_INDEX_NAME_REUSE: ReadonlySet<string> = new Set([
  '0065_attendance_checks inventory.apr_org_idx',
]);

const CREATE_INDEX =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:ONLY\s+)?"?(\w+)"?\s*\.\s*"?(\w+)"?/gi;
const DROP_INDEX =
  /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?\s*\.\s*"?(\w+)"?/gi;

export type IndexStatement =
  | { op: 'create'; index: string; table: string }
  | { op: 'drop'; index: string };

/**
 * The schema-qualified index statements in one migration, in order and
 * lower-cased (`index` is `schema.name`). Comments are skipped.
 */
export function indexStatements(sql: string): IndexStatement[] {
  const code = sql.replace(/--[^\n]*/g, '');
  const found: Array<{ at: number; statement: IndexStatement }> = [];
  for (const m of code.matchAll(CREATE_INDEX)) {
    const [, name, schema, table] = m as unknown as [string, string, string, string];
    found.push({
      at: m.index ?? 0,
      statement: {
        op: 'create',
        index: `${schema}.${name}`.toLowerCase(),
        table: `${schema}.${table}`.toLowerCase(),
      },
    });
  }
  for (const m of code.matchAll(DROP_INDEX)) {
    const [, schema, name] = m as unknown as [string, string, string];
    found.push({
      at: m.index ?? 0,
      statement: { op: 'drop', index: `${schema}.${name}`.toLowerCase() },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.statement);
}

/**
 * Index names a migration gives to a second table while the first still
 * has it. `files` are in migration order. A name freed by DROP INDEX may
 * name another table afterwards.
 */
export function indexNameReuse(
  files: ReadonlyArray<{ tag: string; sql: string }>,
  allowed: ReadonlySet<string> = LEGACY_INDEX_NAME_REUSE,
): Array<{ tag: string; index: string; tables: [string, string] }> {
  const owner = new Map<string, string>();
  const problems: Array<{ tag: string; index: string; tables: [string, string] }> = [];
  for (const { tag, sql } of files) {
    for (const statement of indexStatements(sql)) {
      if (statement.op === 'drop') {
        owner.delete(statement.index);
        continue;
      }
      const table = owner.get(statement.index);
      if (table === undefined) owner.set(statement.index, statement.table);
      else if (table !== statement.table && !allowed.has(`${tag} ${statement.index}`)) {
        problems.push({ tag, index: statement.index, tables: [table, statement.table] });
      }
    }
  }
  return problems;
}
