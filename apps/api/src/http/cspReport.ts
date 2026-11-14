/**
 * POST /csp-report: where browsers send what the report-only
 * Content-Security-Policy would have blocked (securityHeaders.ts).
 *
 * Reviews MWD-12 / MWD-13 (modern-web-guidance: security, trusted-types):
 * the stricter policy (narrow connect-src, Trusted Types) is rolled out
 * report-only first, and nobody saw violations, as nothing collected
 * them. This takes both formats: `application/csp-report` (the older
 * `report-uri`, one report) and `application/reports+json` (the
 * Reporting API's `report-to`, a list), and writes one compact line per
 * report to the log. Nothing is stored in the database.
 *
 * Public, as browsers send no credentials: the body is capped at
 * CSP_REPORT_MAX_BYTES, the caller is rate-limited, at most
 * CSP_REPORTS_PER_REQUEST reports of a body are read, every field is
 * clamped, URLs lose their query and fragment (Telegram's launch data
 * rides in the fragment) and what is left is masked (MWD-15). It answers
 * 204 to anything it accepted, so a browser has nothing to retry.
 */
import type { Context } from 'hono';
import { checkClientRate } from '../services/rateLimit';
import { redactLogText } from '../services/redactLog';

export const CSP_REPORT_PATH = '/csp-report';
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const CSP_REPORTS_PER_REQUEST = 10;
/** Per client address; a page with many violations sends many reports. */
export const CSP_REPORT_LIMIT = { window: 60_000, max: 60 };

const ACCEPTED_TYPES = new Set(['application/csp-report', 'application/reports+json']);
const FIELD_MAX = 200;

/** One violation, as written to the log. */
export interface CspViolation {
  directive: string | null;
  blocked: string | null;
  document: string | null;
  source: string | null;
  line: number | null;
  sample: string | null;
  disposition: string | null;
}

export interface CspReportDeps {
  /** The client address to rate-limit on (trustedClientIp), or null. */
  clientIp: (c: Context) => string | null;
  /** Where the compact line goes (the api's logger). */
  log: (violations: CspViolation[]) => void;
}

/** A URL without its query and fragment; a keyword ("inline", "eval") as it is. */
function bareUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const cut = value.split(/[?#]/, 1)[0] ?? '';
  return text(cut);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return redactLogText(value.slice(0, FIELD_MAX)).slice(0, FIELD_MAX);
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The violations in a report body, compact and masked. Pure. Anything
 * that is not a CSP report is skipped.
 */
export function readCspReports(contentType: string, body: unknown): CspViolation[] {
  if (contentType === 'application/csp-report') {
    const r = record(record(body)?.['csp-report']);
    if (!r) return [];
    return [
      {
        directive: text(r['effective-directive'] ?? r['violated-directive']),
        blocked: bareUrl(r['blocked-uri']),
        document: bareUrl(r['document-uri']),
        source: bareUrl(r['source-file']),
        line: int(r['line-number']),
        sample: text(r['script-sample']),
        disposition: text(r.disposition),
      },
    ];
  }
  if (!Array.isArray(body)) return [];
  const out: CspViolation[] = [];
  for (const item of body.slice(0, CSP_REPORTS_PER_REQUEST)) {
    const report = record(item);
    if (report?.type !== 'csp-violation') continue;
    const b = record(report.body);
    if (!b) continue;
    out.push({
      directive: text(b.effectiveDirective),
      blocked: bareUrl(b.blockedURL),
      document: bareUrl(b.documentURL ?? report.url),
      source: bareUrl(b.sourceFile),
      line: int(b.lineNumber),
      sample: text(b.sample),
      disposition: text(b.disposition),
    });
  }
  return out;
}

/** The body as text, or null once it passes `max` bytes. */
async function readCapped(c: Context, max: number): Promise<string | null> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function cspReportHandler(deps: CspReportDeps) {
  return async (c: Context) => {
    if (!checkClientRate('csp-report', deps.clientIp(c), CSP_REPORT_LIMIT)) {
      return c.body(null, 429);
    }
    const contentType = (c.req.header('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(contentType)) return c.body(null, 415);
    const raw = await readCapped(c, CSP_REPORT_MAX_BYTES);
    if (raw === null) return c.body(null, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.body(null, 400);
    }
    const violations = readCspReports(contentType, body);
    if (violations.length > 0) deps.log(violations);
    return c.body(null, 204);
  };
}
