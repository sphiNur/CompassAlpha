/**
 * Upload router — issues short-lived presigned PUT URLs the browser
 * uploads directly to S3 / MinIO.
 *
 * Why direct-to-S3 instead of streaming through the API?
 *   1. Avoids loading the request body in the API process (a 5 MB photo
 *      x 30 concurrent purchasers = 150 MB API memory churn).
 *   2. Lets us cap the file size at the bucket policy / server-side
 *      enforcement layer rather than in JS.
 *   3. The `domain.events.payload` JSONB column stays small — we only
 *      ever store the public https URL, never base64.
 *
 * The presigned URL is good for `expiresInSeconds` (default 600 = 10 min);
 * after that the browser must call `requestPresign` again. Object key
 * shape: `<orgId>/<userId>/<kind>/<yyyy-mm-dd>/<uuid>.<ext>`. orgId/userId
 * come from the auth ctx (NOT the input) so a user cannot upload into
 * another tenant's namespace.
 */
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { RequestPresignInputSchema, UPLOAD_MAX_BYTES } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import { isS3Configured, presignPut, S3NotConfiguredError } from '../../services/s3';

/** Browser-allowed image MIME types. JPEG covers PhotoCapture; PNG / WebP for catalog. */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const uploadRouter = router({
  requestPresign: authedProcedure
    .input(RequestPresignInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!isS3Configured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'upload.errors.notConfigured',
        });
      }
      if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'upload.errors.unsupportedContentType',
        });
      }

      const ext = pickExtension(input.contentType);
      const datePart = new Date().toISOString().slice(0, 10);
      const key =
        `${ctx.session!.orgId}/${ctx.session!.userId}/${input.kind}/${datePart}/${randomUUID()}.${ext}`;

      try {
        const presigned = presignPut({
          key,
          contentType: input.contentType,
          contentLength: input.contentLength,
          expiresInSeconds: 600,
        });
        return presigned;
      } catch (err) {
        if (err instanceof S3NotConfiguredError) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'upload.errors.notConfigured',
          });
        }
        throw err;
      }
    }),

  /**
   * Health check for the FE: tells whether real uploads are wired up
   * (vs. data: URI fallback). Cheap query, no side effects.
   */
  config: authedProcedure.query(() => ({
    enabled: isS3Configured(),
    maxBytes: UPLOAD_MAX_BYTES,
    allowedContentTypes: Array.from(ALLOWED_CONTENT_TYPES),
  })),
});

export function pickExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}
