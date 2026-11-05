/**
 * GET /files/attendance-month.xlsx?t=<signed link> (2026-11-05). The link
 * comes from `attendance.exportLink` and lives five minutes; the member's
 * session and permission are loaded again here, so a link stops working
 * when the member loses access.
 */
import type { Context } from 'hono';
import { TRPCError } from '@trpc/server';
import { getDb, withOrgContext } from '@compass/db';
import { env } from '../env';
import { logger } from '../infra/log';
import { loadSession } from '../trpc/context';
import { loadMonthSheet } from '../trpc/routers/attendance';
import {
  contentDisposition,
  exportFileName,
  monthWorkbook,
  verifyExportToken,
  type ExportClaims,
} from '../services/attendanceExport';

export async function attendanceMonthExport(c: Context): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  let claims: ExportClaims;
  try {
    claims = await verifyExportToken(c.req.query('t') ?? '');
  } catch {
    return c.text('This download link has expired. Export again from the app.', 410);
  }
  const db = getDb(env.DATABASE_URL);
  try {
    const session = await loadSession(db, claims.sub, claims.org, claims.mid);
    if (!session) return c.text('Forbidden', 403);
    const { store, sheet } = await withOrgContext(db, claims.org, (tx) =>
      loadMonthSheet(tx, session, claims.storeId, claims.month),
    );
    const { bytes } = await monthWorkbook(sheet, claims.locale);
    const fileName = await exportFileName(claims.locale, store.name, claims.month);
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': contentDisposition(fileName),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) {
      return c.text('Forbidden', 403);
    }
    logger.error({ err }, 'attendance month export failed');
    return c.text('Export failed', 500);
  }
}
