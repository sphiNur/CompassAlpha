/**
 * Logged database errors carry no query parameters (review 2026-11-07):
 * drizzle's error message repeats them all, which for attendance means a
 * face photo's bytes, face features and a punch's coordinates.
 */
import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm';
import { serializeError } from '../infra/log';

describe('error log', () => {
  test('a failed query is logged without its parameters', () => {
    const photo = Buffer.from('JPEG-BYTES-OF-A-FACE');
    const cause = new Error('duplicate key value violates unique constraint "x"');
    const err = new DrizzleQueryError(
      'insert into "inventory"."attendance_punches" ("geo_lat", "feature", "bytes") values ($1, $2, $3)',
      ['41.311081', [0.123456, 0.654321], photo],
      cause,
    );
    const text = JSON.stringify(serializeError(err));
    expect(text).toContain('Failed query: insert into');
    expect(text).toContain('[not logged]');
    expect(text).toContain('duplicate key value');
    expect(text).not.toContain('41.311081');
    expect(text).not.toContain('0.123456');
    expect(text).not.toContain('JPEG-BYTES-OF-A-FACE');
  });

  test('wrapped in another error, the parameters stay out too', () => {
    const inner = new DrizzleQueryError('select 1 where id = $1', ['secret-41.31'], undefined);
    const outer = new Error('trpc failed', { cause: inner });
    const text = JSON.stringify(serializeError(outer));
    expect(text).toContain('trpc failed');
    expect(text).not.toContain('secret-41.31');
  });

  test('ordinary errors are logged as before', () => {
    const out = serializeError(new Error('plain')) as { message: string; type: string };
    expect(out.message).toBe('plain');
    expect(out.type).toBe('Error');
  });
});
