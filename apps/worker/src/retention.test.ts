import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  deleteInBatches,
  RETENTION_RULES,
  retentionDeleteSql,
  type RetentionRule,
} from './retention';

const dialect = new PgDialect();

describe('RETENTION_RULES', () => {
  test('match the decided windows (CA-38)', () => {
    const byTable = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, r]));
    expect(byTable['ops.notifications']).toMatchObject({ column: 'created_at', days: 90 });
    expect(byTable['sync.outbox']).toMatchObject({ column: 'sent_at', days: 30 });
    expect(byTable['ops.client_logs']).toMatchObject({ column: 'created_at', days: 30 });
  });
});

describe('retentionDeleteSql', () => {
  test('builds a LIMIT-ed subselect delete with bound days/limit', () => {
    const q = dialect.sqlToQuery(retentionDeleteSql(RETENTION_RULES[1]!, 500));
    const text = q.sql.replace(/\s+/g, ' ').trim();
    expect(text).toContain('DELETE FROM sync.outbox WHERE id IN ( SELECT id FROM sync.outbox');
    expect(text).toContain('WHERE sent_at < NOW() -');
    expect(text).toContain('LIMIT $2::int');
    expect(text).toContain('RETURNING id');
    expect(q.params).toEqual([30, 500]);
  });

  test('rejects anything that is not a plain identifier', () => {
    const bad: RetentionRule = {
      name: 'x',
      table: 'ops.notifications; DROP TABLE x',
      column: 'created_at',
      days: 1,
    };
    expect(() => retentionDeleteSql(bad, 10)).toThrow();
    expect(() => retentionDeleteSql({ ...RETENTION_RULES[0]!, days: 0 }, 10)).toThrow();
    expect(() => retentionDeleteSql(RETENTION_RULES[0]!, 0)).toThrow();
  });
});

describe('deleteInBatches', () => {
  test('stops at the first short batch', async () => {
    const results = [10, 10, 3];
    const calls: number[] = [];
    const r = await deleteInBatches(
      async (limit) => {
        calls.push(limit);
        return results.shift() ?? 0;
      },
      10,
      100,
    );
    expect(r).toEqual({ deleted: 23, batches: 3, exhausted: false });
    expect(calls).toEqual([10, 10, 10]);
  });

  test('an empty table costs exactly one batch', async () => {
    const r = await deleteInBatches(async () => 0, 10, 100);
    expect(r).toEqual({ deleted: 0, batches: 1, exhausted: false });
  });

  test('caps the work per tick', async () => {
    const r = await deleteInBatches(async (limit) => limit, 10, 4);
    expect(r).toEqual({ deleted: 40, batches: 4, exhausted: true });
  });
});
