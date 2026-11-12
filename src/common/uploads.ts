import { env } from "@/env";
import { getPresignedPutUrl } from "@/server/file-upload-actions";
import type { getPresignedUrlOptions } from "@/server/file-uploads";

/**
 * Browser-side upload. The presigned URL comes from an authorized server
 * action; server code must use `uploadFile` from `@/server/file-uploads`.
 *
 * usage
 * ```js
 * import { uploadFile } from '@/common/uploads'
 *
 * const handleUpload = async (file: File) => {
 *   const { uploadKey } = await uploadFile(file);
 *
 *   // save to the database
 *   saveDB({ uploadKey });
 * };
 * ```
 */

export const uploadFile = async (
  file: File,
  options: Pick<
    getPresignedUrlOptions,
    "expiresIn" | "keyPrefix" | "identifier"
  >,
  bucketMode: "publicBucket" | "privateBucket" = "privateBucket",
) => {
  const { url, key, bucketUrl } = await getPresignedPutUrl({
    contentType: file.type,
    fileName: file.name,
    bucketMode,
    ...options,
  });
  const body = await file.arrayBuffer();
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      // Public-bucket URLs are signed with the file's content type.
      "Content-Type":
        bucketMode === "publicBucket" ? file.type : "application/octet-stream",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to upload file "${file.name}", failed with status code ${res.status}`,
    );
  }

  const { name, type, size } = file;
  let fileUrl = bucketUrl;

  const uploadDomain =
    process.env.NEXT_PUBLIC_UPLOAD_DOMAIN || env.NEXT_PUBLIC_UPLOAD_DOMAIN;

  if (bucketMode === "publicBucket" && uploadDomain) {
    fileUrl = `${uploadDomain}/${key}`;
  }

  return {
    key,
    name,
    mimeType: type,
    size,
    fileUrl,
  };
};

export type TUploadFile = Awaited<ReturnType<typeof uploadFile>>;
