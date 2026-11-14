/**
 * Reviews MWD-12 / MWD-13 (modern-web-guidance: security, trusted-types):
 * POST /csp-report takes both report formats, is capped and rate-limited,
 * and logs a compact, masked line.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  CSP_REPORT_LIMIT,
  CSP_REPORT_MAX_BYTES,
  CSP_REPORTS_PER_REQUEST,
  cspReportHandler,
  readCspReports,
  type CspViolation,
} from '../http/cspReport';
import { _resetRateBuckets } from '../services/rateLimit';

let logged: CspViolation[][] = [];

function app(ip: string | null = '203.0.113.7') {
  const a = new Hono();
  a.post('/csp-report', cspReportHandler({ clientIp: () => ip, log: (v) => logged.push(v) }));
  return a;
}

const post = (body: string, type: string, a = app()) =>
  a.request('/csp-report', { method: 'POST', headers: { 'content-type': type }, body });

const legacy = {
  'csp-report': {
    'document-uri': 'https://compass.example/order?x=1#tgWebAppData=query_id%3DAAH%26hash%3Dabc',
    'violated-directive': 'connect-src',
    'effective-directive': 'connect-src',
    'blocked-uri': 'https://evil.example/collect?token=abc',
    'source-file': 'https://compass.example/assets/index-1a2b.js',
    'line-number': 12,
    'script-sample': 'mail ali@mail.example',
    disposition: 'report',
  },
};

const modern = [
  {
    type: 'csp-violation',
    url: 'https://compass.example/attendance#tgWebAppData=x',
    body: {
      documentURL: 'https://compass.example/attendance#tgWebAppData=x',
      effectiveDirective: 'require-trusted-types-for',
      blockedURL: 'trusted-types-sink',
      sourceFile: 'https://compass.example/assets/vision.js',
      lineNumber: 1,
      sample: 'HTMLScriptElement src|/assets/vision_wasm_internal.js',
      disposition: 'report',
    },
  },
  { type: 'deprecation', body: { id: 'x' } },
];

beforeEach(() => {
  logged = [];
  _resetRateBuckets();
});

describe('POST /csp-report', () => {
  test('application/csp-report: 204 and one compact line, URLs bare, text masked', async () => {
    const res = await post(JSON.stringify(legacy), 'application/csp-report');
    expect(res.status).toBe(204);
    expect(logged).toEqual([
      [
        {
          directive: 'connect-src',
          blocked: 'https://evil.example/collect',
          document: 'https://compass.example/order',
          source: 'https://compass.example/assets/index-1a2b.js',
          line: 12,
          sample: 'mail [email]',
          disposition: 'report',
        },
      ],
    ]);
    expect(JSON.stringify(logged)).not.toContain('tgWebAppData');
  });

  test('application/reports+json: the CSP reports of the list only', async () => {
    const res = await post(JSON.stringify(modern), 'application/reports+json; charset=utf-8');
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toHaveLength(1);
    expect(logged[0]![0]!.directive).toBe('require-trusted-types-for');
    expect(logged[0]![0]!.document).toBe('https://compass.example/attendance');
  });

  test('at most CSP_REPORTS_PER_REQUEST reports of one body', () => {
    const many = Array.from({ length: 50 }, () => modern[0]);
    expect(readCspReports('application/reports+json', many)).toHaveLength(CSP_REPORTS_PER_REQUEST);
    expect(readCspReports('application/csp-report', { nope: 1 })).toEqual([]);
    expect(readCspReports('application/reports+json', { not: 'a list' })).toEqual([]);
  });

  test('another type is 415, a body past the cap 413, bad JSON 400; none logged', async () => {
    expect((await post(JSON.stringify(legacy), 'application/json')).status).toBe(415);
    const big = JSON.stringify({
      'csp-report': { 'script-sample': 'x'.repeat(CSP_REPORT_MAX_BYTES) },
    });
    expect((await post(big, 'application/csp-report')).status).toBe(413);
    expect((await post('{', 'application/csp-report')).status).toBe(400);
    expect(logged).toEqual([]);
  });

  test('rate-limited per client address', async () => {
    const a = app('198.51.100.9');
    for (let i = 0; i < CSP_REPORT_LIMIT.max; i++) {
      expect((await post(JSON.stringify(legacy), 'application/csp-report', a)).status).toBe(204);
    }
    expect((await post(JSON.stringify(legacy), 'application/csp-report', a)).status).toBe(429);
    // Another address still gets through.
    expect((await post(JSON.stringify(legacy), 'application/csp-report', app())).status).toBe(204);
  });
});
