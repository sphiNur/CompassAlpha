/**
 * The SigV4 PUT presigner (services/s3.ts), and the URL shape it gives
 * for MinIO (path-style) and AWS (virtual-hosted).
 *
 * The signature is checked byte for byte twice:
 *   - the shared signer against AWS's documented example, a GET with host
 *     as the only signed header:
 *     https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *   - presignPut (a PUT that also signs content-type) against a signature
 *     computed independently with Python's hmac and hashlib.
 * Review TEST2-06 (2026-11-09): this header claimed the AWS check before
 * any test made it; presignPut read the clock, so no fixed value could
 * be compared. It now takes `now`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const ORIG = { ...process.env };

beforeAll(() => {
  process.env.S3_BUCKET = 'examplebucket';
  process.env.S3_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  process.env.S3_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  process.env.S3_REGION = 'us-east-1';
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_PUBLIC_BASE;
});

afterAll(() => {
  process.env = ORIG;
});

describe('s3 presigner', () => {
  it("signs AWS's documented example byte for byte", async () => {
    const { presignedUrl } = await import('../services/s3');
    const url = presignedUrl({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresIn: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    // AWS lists the parameters in another order; S3 does not mind.
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404' +
        '&X-Amz-SignedHeaders=host',
    );
  });

  it('signs a PUT with its content type as computed independently', async () => {
    const { presignPut } = await import('../services/s3');
    const out = presignPut({
      key: 'org-1/user-2/receipts/abc.jpg',
      contentType: 'image/jpeg',
      expiresInSeconds: 600,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    const u = new URL(out.url);
    expect(u.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(u.searchParams.get('X-Amz-Signature')).toBe(
      '8922e38b5da4320b6782cb6282f1570aed39f6a15127eddc33834cda19b9ca92',
    );
  });

  it('uses virtual-hosted style for default AWS endpoint', async () => {
    const { presignPut } = await import('../services/s3');
    const out = presignPut({
      key: 'org-1/user-2/receipts/abc.jpg',
      contentType: 'image/jpeg',
      expiresInSeconds: 600,
    });
    const u = new URL(out.url);
    expect(u.host).toBe('examplebucket.s3.amazonaws.com');
    expect(u.pathname).toBe('/org-1/user-2/receipts/abc.jpg');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('X-Amz-Signature')!.length).toBe(64);
    // publicUrl strips signing params.
    expect(out.publicUrl).toBe(
      'https://examplebucket.s3.amazonaws.com/org-1/user-2/receipts/abc.jpg',
    );
    // requiredHeaders include only Content-Type (host is auto by browser).
    expect(out.requiredHeaders['Content-Type']).toBe('image/jpeg');
  });

  it('uses path-style for custom S3 endpoint (MinIO)', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_REGION = 'us-east-1';
    // dynamic re-import doesn't help because env is cached on first
    // import; instead we read the module's behavior with the values we
    // set in beforeAll (us-east-1 + endpoint). Since the s3 module
    // reads env at call-time, this works.
    const { presignPut } = await import('../services/s3');
    const out = presignPut({
      key: 'org-1/file.jpg',
      contentType: 'image/jpeg',
    });
    const u = new URL(out.url);
    expect(u.host).toBe('localhost:9000');
    expect(u.pathname).toBe('/examplebucket/org-1/file.jpg');
    delete process.env.S3_ENDPOINT;
  });

  it('encodes path segments correctly (spaces → %20)', async () => {
    const { presignPut } = await import('../services/s3');
    const out = presignPut({
      key: 'org/foo bar.jpg',
      contentType: 'image/jpeg',
    });
    const u = new URL(out.url);
    expect(u.pathname).toBe('/org/foo%20bar.jpg');
  });

  it('strips leading slashes from key', async () => {
    const { presignPut } = await import('../services/s3');
    const out = presignPut({ key: '/org/file.jpg', contentType: 'image/jpeg' });
    expect(out.key).toBe('org/file.jpg');
  });

  it('respects S3_PUBLIC_BASE for the read URL but not the signing URL', async () => {
    process.env.S3_PUBLIC_BASE = 'https://cdn.example.com/photos';
    const { presignPut } = await import('../services/s3');
    const out = presignPut({ key: 'org/file.jpg', contentType: 'image/jpeg' });
    expect(out.publicUrl).toBe('https://cdn.example.com/photos/org/file.jpg');
    expect(new URL(out.url).host).toBe('examplebucket.s3.amazonaws.com');
    delete process.env.S3_PUBLIC_BASE;
  });

  it('clamps expiresInSeconds to [60, 86400]', async () => {
    const { presignPut } = await import('../services/s3');
    const lo = presignPut({ key: 'a', contentType: 'image/jpeg', expiresInSeconds: 1 });
    const hi = presignPut({ key: 'a', contentType: 'image/jpeg', expiresInSeconds: 10_000_000 });
    expect(new URL(lo.url).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(new URL(hi.url).searchParams.get('X-Amz-Expires')).toBe('86400');
  });

  it('throws S3NotConfiguredError when credentials are missing', async () => {
    const orig = process.env.S3_SECRET_KEY;
    delete process.env.S3_SECRET_KEY;
    const { presignPut, S3NotConfiguredError } = await import('../services/s3');
    expect(() => presignPut({ key: 'a', contentType: 'image/jpeg' })).toThrow(
      S3NotConfiguredError,
    );
    process.env.S3_SECRET_KEY = orig;
  });
});
