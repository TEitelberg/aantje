// The S3 calls of `AwsApi`, part of the bundle `dist/aws-sdk.js` (see `sdk.ts`).
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { AwsCallError, isAwsCallError } from './api';
import type { AwsApi } from './api';
import type { Call } from './sdk';

export function bucketCalls(s3: S3Client, call: Call): Pick<AwsApi, 'bucketTaken' | 'emptyBucket'> {
  return {
    async bucketTaken(name) {
      try {
        await call('s3:HeadBucket', () => s3.send(new HeadBucketCommand({ Bucket: name })));
        return true;
      } catch (error) {
        if (isAwsCallError(error) && (error.status === 404 || error.code === 'NotFound')) return false;
        // 403: the bucket exists and belongs to someone else; 301: it is in another region.
        if (isAwsCallError(error) && (error.status === 403 || error.status === 301)) return true;
        throw error;
      }
    },
    async emptyBucket(bucket, report) {
      let objects = 0;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await call('s3:ListObjectVersions', () =>
          s3.send(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              VersionIdMarker: versionMarker,
            }),
          ),
        );
        const found = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((entry) =>
          entry.Key ? [{ Key: entry.Key, ...(entry.VersionId ? { VersionId: entry.VersionId } : {}) }] : [],
        );
        // DeleteObjects takes at most 1000 keys; a page of ListObjectVersions has at most 1000 entries of each kind.
        for (let start = 0; start < found.length; start += 1000) {
          const batch = found.slice(start, start + 1000);
          const { Errors } = await call('s3:DeleteObjects', () =>
            s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } })),
          );
          const [failed] = Errors ?? [];
          if (failed) {
            throw new AwsCallError(
              's3:DeleteObjects',
              failed.Code ?? 'Error',
              undefined,
              `${failed.Key ?? ''}: ${failed.Message ?? ''}`,
            );
          }
          objects += batch.length;
          report?.(objects);
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker !== undefined);
      let uploads = 0;
      let uploadKey: string | undefined;
      let uploadId: string | undefined;
      do {
        const page = await call('s3:ListMultipartUploads', () =>
          s3.send(
            new ListMultipartUploadsCommand({
              Bucket: bucket,
              KeyMarker: uploadKey,
              UploadIdMarker: uploadId,
            }),
          ),
        );
        for (const upload of page.Uploads ?? []) {
          if (!upload.Key || !upload.UploadId) continue;
          await call('s3:AbortMultipartUpload', () =>
            s3.send(
              new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId }),
            ),
          );
          uploads += 1;
        }
        uploadKey = page.IsTruncated ? page.NextKeyMarker : undefined;
        uploadId = page.IsTruncated ? page.NextUploadIdMarker : undefined;
      } while (uploadKey !== undefined);
      return { objects, uploads };
    },
  };
}
