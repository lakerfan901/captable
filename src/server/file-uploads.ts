import "server-only";

import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import slugify from "@sindresorhus/slugify";
import { customId } from "@/common/id";
import { env } from "@/env";
import {
  attachmentDisposition,
  isInlineContentType,
  storedContentType,
} from "@/lib/inline-content-type";

const region = env.UPLOAD_REGION;
const endpoint = env.UPLOAD_ENDPOINT;
const accessKeyId = env.UPLOAD_ACCESS_KEY_ID;
const secretAccessKey = env.UPLOAD_SECRET_ACCESS_KEY;
const hasCredentials = accessKeyId && secretAccessKey;
const PrivateBucket = env.UPLOAD_BUCKET_PRIVATE;
const PublicBucket = env.UPLOAD_BUCKET_PUBLIC;

const S3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: env.UPLOAD_FORCE_PATH_STYLE,
  credentials: hasCredentials
    ? {
        secretAccessKey,
        accessKeyId,
      }
    : undefined,
});

export type TypeKeyPrefixes =
  | "new-safes"
  | "existing-safes"
  | "signed-esign-doc"
  | "unsigned-esign-doc"
  | "stock-option-docs"
  | "company-logos"
  | "profile-avatars"
  | "generic-documents"
  | "shares-docs"
  | `data-room/${string}`
  | "resolutions"
  | "member-reports";

export interface getPresignedUrlOptions {
  contentType: string;
  expiresIn?: number;
  fileName: string;
  keyPrefix: TypeKeyPrefixes;
  // should be companyPublicId or memberId or userId
  identifier: string;
  bucketMode: "privateBucket" | "publicBucket";
  /**
   * Include Content-Type in the signature so the uploader must send exactly
   * `contentType`. Used for public-bucket uploads so a client cannot store
   * e.g. text/html where an image was authorized.
   */
  signContentType?: boolean;
}

const TEN_MINUTES_IN_SECONDS = 10 * 60;

export const getPresignedPutUrl = async ({
  contentType,
  expiresIn,
  fileName,
  keyPrefix,
  identifier,
  bucketMode,
  signContentType,
}: getPresignedUrlOptions) => {
  const { name, ext } = path.parse(fileName);

  const Key = `${identifier}/${keyPrefix}-${slugify(name)}-${customId(
    12,
  )}${ext}`;

  const putObjectCommand = new PutObjectCommand({
    Bucket: bucketMode === "privateBucket" ? PrivateBucket : PublicBucket,
    Key,
    ContentType: contentType,
    ACL: bucketMode === "privateBucket" ? "private" : "public-read",
  });

  const url: string = await getSignedUrl(S3, putObjectCommand, {
    expiresIn: expiresIn ?? TEN_MINUTES_IN_SECONDS,
    ...(signContentType && { signableHeaders: new Set(["content-type"]) }),
  });

  const bucketUrl = new URL(url);
  bucketUrl.search = "";

  return { url, key: Key, bucketUrl: bucketUrl.toString() };
};

/**
 * A 10-minute presigned GET URL of a private object. With `file` (the
 * Bucket row's `mimeType` and `name`), the response headers are set from the
 * stored type, whatever the object was uploaded with: PDF and raster images
 * are served with their type and `inline` (they open in the tab), anything
 * else as `application/octet-stream` and `attachment` (downloaded, never
 * rendered on the storage origin). See src/lib/inline-content-type.ts.
 */
export const getPresignedGetUrl = async (
  key: string,
  file?: { mimeType: string; name: string },
) => {
  const inline = file === undefined || isInlineContentType(file.mimeType);
  const getObjectCommand = new GetObjectCommand({
    Bucket: PrivateBucket,
    Key: key,
    ResponseContentDisposition: inline
      ? "inline"
      : attachmentDisposition(file?.name ?? "download"),
    ...(file !== undefined && {
      ResponseContentType: storedContentType(file.mimeType),
    }),
  });

  const url = await getSignedUrl(S3, getObjectCommand, {
    expiresIn: TEN_MINUTES_IN_SECONDS,
  });

  return { key, url };
};

/**
 * Server-side upload for trusted callers (jobs, tRPC procedures). Browser
 * code must use `uploadFile` from `@/common/uploads`, which goes through the
 * authorized server action.
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
      // The real type only for inline-safe files (src/lib/inline-content-type.ts).
      "Content-Type":
        bucketMode === "publicBucket"
          ? "application/octet-stream"
          : storedContentType(file.type),
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

export const getFileFromS3 = async (key: string) => {
  const { url } = await getPresignedGetUrl(key);

  const response = await fetch(url, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to get file "${key}", failed with status code ${response.status}`,
    );
  }

  const buffer = await response.arrayBuffer();

  const binaryData = new Uint8Array(buffer);

  return binaryData;
};
