/**
 * GET /files/attendance-month.xlsx?t=<signed link> (2026-11-05). The link
 * comes from `attendance.exportLink` and lives five minutes; the member's
 * session and permission are loaded again here, so a link stops working
 * when the member loses access.
 */
import type { Context } from 'hono';
import { TRPCError } from '@trpc/server';
import { errors } from 'jose';
import { getDb, withOrgContext } from '@compass/db';
import { detectLocale, format, loadCatalog, type CatalogKey, type Locale } from '@compass/i18n';
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

/**
 * Review ATT-15: Telegram opens the link outside the app, so when the file
 * cannot be had, this text is all the person sees. It is in the language
 * the link was asked for in.
 */
async function failure(
  c: Context,
  status: 403 | 410 | 500,
  key: CatalogKey,
  locale: Locale,
): Promise<Response> {
  await Promise.all([loadCatalog(locale), loadCatalog('en')]);
  return c.text(format(key, locale), status);
}

/**
 * The language of a link that did not verify. An expired link was signed
 * here, and jose hands back its claims; for any other, the browser's first
 * language.
 */
function failedLinkLocale(err: unknown, acceptLanguage: string | undefined): Locale {
  if (err instanceof errors.JWTExpired && typeof err.payload.locale === 'string') {
    return detectLocale(err.payload.locale);
  }
  return detectLocale(acceptLanguage);
}

export async function attendanceMonthExport(c: Context): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  let claims: ExportClaims;
  try {
    claims = await verifyExportToken(c.req.query('t') ?? '');
  } catch (err) {
    const locale = failedLinkLocale(err, c.req.header('accept-language'));
    return failure(c, 410, 'attendance.export.linkExpired', locale);
  }
  const db = getDb(env.DATABASE_URL);
  try {
    const session = await loadSession(db, claims.sub, claims.org, claims.mid);
    if (!session) return await failure(c, 403, 'attendance.export.noAccess', claims.locale);
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
      return failure(c, 403, 'attendance.export.noAccess', claims.locale);
    }
    logger.error({ err }, 'attendance month export failed');
    return failure(c, 500, 'attendance.export.failed', claims.locale);
  }
}
