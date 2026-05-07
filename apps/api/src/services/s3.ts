/**
 * Minimal S3-compatible presigned PUT generator.
 *
 * Why not @aws-sdk/* ?  The SDK pulls ~10 MB of polyfills and we only
 * need ONE thing: a presigned PUT URL the browser can hit directly.
 * SigV4 query-string signing is ~70 lines of crypto.
 *
 * Works against:
 *   - Local MinIO (S3_ENDPOINT=http://localhost:9000, S3_REGION=us-east-1)
 *   - AWS S3 (S3_ENDPOINT omitted, S3_REGION=…)
 *   - Cloudflare R2 (S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com, S3_REGION=auto)
 *   - Tencent COS (S3_ENDPOINT=https://cos.<region>.myqcloud.com, S3_REGION=<region>)
 *
 * Usage:
 *   const { url, publicUrl, key } = presignPut({
 *     key: 'org-uuid/user-uuid/receipts/2026-05-01/abc.jpg',
 *     contentType: 'image/jpeg',
 *     contentLength: 245_388,
 *     expiresInSeconds: 600,
 *   });
 *
 * The browser then PUTs the file to `url` with the matching Content-Type
 * and Content-Length headers, and we store `publicUrl` in the domain
 * event payload.
 */
import { createHash, createHmac } from 'node:crypto';

/**
 * Reads S3 settings from process.env at call-time (not module-load).
 * The boot-time @t3-oss/env-core schema in env.ts marks these as optional
 * and validates the URL shape; once boot has passed, we rely on
 * process.env directly so unit tests can flip credentials between cases.
 */
function readS3Env() {
  return {
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    publicBase: process.env.S3_PUBLIC_BASE,
  };
}

export interface PresignedPut {
  /** Sign URL the browser PUTs to. */
  url: string;
  /** Stable HTTPS URL the browser/app reads from after upload. */
  publicUrl: string;
  /** Object key inside the bucket (no leading slash). */
  key: string;
  /** Echo of expires-in seconds. */
  expiresIn: number;
  /** Required headers the browser MUST send during the PUT. */
  requiredHeaders: Record<string, string>;
}

export interface PresignPutInput {
  key: string;
  contentType: string;
  /** Hint only — not signed. We sign UNSIGNED-PAYLOAD so any size works. */
  contentLength?: number;
  /** Default 600 (10 min). Min 60, max 86400 (24 h). */
  expiresInSeconds?: number;
}

export class S3NotConfiguredError extends Error {
  constructor() {
    super('S3 is not configured (S3_ENDPOINT / S3_BUCKET / credentials missing)');
    this.name = 'S3NotConfiguredError';
  }
}

export function isS3Configured(): boolean {
  const { bucket, accessKey, secretKey } = readS3Env();
  return Boolean(bucket && accessKey && secretKey);
}

/** Build a SigV4 presigned PUT URL. Pure function, no network calls. */
export function presignPut(input: PresignPutInput): PresignedPut {
  if (!isS3Configured()) throw new S3NotConfiguredError();
  const cfg = readS3Env();

  const expiresIn = clamp(input.expiresInSeconds ?? 600, 60, 86_400);
  const region = cfg.region;
  const accessKey = cfg.accessKey!;
  const secretKey = cfg.secretKey!;
  const bucket = cfg.bucket!;
  const key = stripLeadingSlash(input.key);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');

  // Determine endpoint host + path style. Path-style for MinIO/local
  // dev (no DNS magic for buckets); virtual-hosted for AWS/R2/COS.
  const { host, protocol, basePath } = resolveEndpoint(bucket, cfg.endpoint, cfg.region);

  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;

  // Signed headers: just `host` + `content-type` (so the browser MUST
  // send the same content-type or the signature mismatches).
  const signedHeaders = 'content-type;host';

  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', credential);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(expiresIn));
  params.set('X-Amz-SignedHeaders', signedHeaders);

  // Canonical request.
  const canonicalUri = `${basePath}${encodedKey}`;
  const canonicalQueryString = sortedQueryString(params);
  const canonicalHeaders = `content-type:${input.contentType}\nhost:${host}\n`;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(secretKey, dateStamp, region, 's3');
  const signature = hmacHex(signingKey, stringToSign);
  params.set('X-Amz-Signature', signature);

  const url = `${protocol}//${host}${canonicalUri}?${sortedQueryString(params)}`;

  // Public read URL: prefer S3_PUBLIC_BASE if set (e.g. CDN), otherwise
  // build from the same endpoint without the signing query.
  const publicUrl = cfg.publicBase
    ? `${cfg.publicBase.replace(/\/+$/, '')}/${encodedKey}`
    : `${protocol}//${host}${canonicalUri}`;

  return {
    url,
    publicUrl,
    key,
    expiresIn,
    requiredHeaders: {
      'Content-Type': input.contentType,
    },
  };
}

// ---------- helpers ----------

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function stripLeadingSlash(s: string): string {
  return s.startsWith('/') ? s.slice(1) : s;
}

function formatAmzDate(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  return (
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  );
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function sortedQueryString(p: URLSearchParams): string {
  const entries: [string, string][] = [];
  p.forEach((v, k) => entries.push([k, v]));
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

interface ResolvedEndpoint {
  host: string;
  protocol: string;
  /** Path-prefix that includes the bucket if we're using path-style addressing. Always ends with `/`. */
  basePath: string;
}

function resolveEndpoint(
  bucket: string,
  endpoint: string | undefined,
  region: string,
): ResolvedEndpoint {
  if (endpoint) {
    const u = new URL(endpoint);
    // Path-style addressing for custom endpoints — MinIO default. The
    // exception is when the host already starts with `<bucket>.`, in
    // which case we assume virtual-hosted style.
    const hostStartsWithBucket = u.host.toLowerCase().startsWith(`${bucket.toLowerCase()}.`);
    if (hostStartsWithBucket) {
      return {
        host: u.host,
        protocol: u.protocol,
        basePath: '/',
      };
    }
    return {
      host: u.host,
      protocol: u.protocol,
      basePath: `/${bucket}/`,
    };
  }
  // Default = real AWS S3, virtual-hosted style.
  const host =
    region === 'us-east-1'
      ? `${bucket}.s3.amazonaws.com`
      : `${bucket}.s3.${region}.amazonaws.com`;
  return { host, protocol: 'https:', basePath: '/' };
}
