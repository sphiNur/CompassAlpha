/**
 * Wraps `trpc.upload.requestPresign` in the shape `<PhotoCapture>` expects
 * via its `uploader` prop. Returns `null` until we know whether S3 is
 * configured — then either a real uploader (real PUT to S3 / MinIO /
 * R2 / COS) or `null` to keep PhotoCapture in data-URI fallback mode.
 *
 * The fallback path matters: in dev without MinIO running, OR when the
 * server has S3 env vars unset, we'd otherwise block every photo
 * capture with a 412 PRECONDITION_FAILED. data: URI is ugly but it
 * keeps the workflow shippable.
 */
import { useMemo } from 'react';
import { STALE } from '../config/timings';
import { trpc } from '../lib/trpc';
import type { PhotoUploader, PresignedUpload } from '@compass/ui';

export function usePhotoUploader(kind: 'receipt' | 'issue' | 'avatar' | 'sku'): PhotoUploader | undefined {
  const cfgQuery = trpc.upload.config.useQuery(undefined, {
    staleTime: STALE.medium,
    refetchOnWindowFocus: false,
    retry: false,
  });
  // Review COREWEB2-30: mutateAsync keeps its identity across renders, so
  // it can be a dependency; the lint suppression is gone.
  const { mutateAsync } = trpc.upload.requestPresign.useMutation();
  const enabled = cfgQuery.data?.enabled === true;

  return useMemo<PhotoUploader | undefined>(() => {
    if (!enabled) return undefined;
    return {
      requestPresign: (args: { contentType: string; contentLength: number }): Promise<PresignedUpload> =>
        mutateAsync({
          kind,
          contentType: args.contentType,
          contentLength: args.contentLength,
        }),
    };
  }, [enabled, kind, mutateAsync]);
}
