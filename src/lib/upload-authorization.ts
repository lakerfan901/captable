/**
 * Pure authorization rules for browser-initiated uploads/downloads.
 *
 * Kept free of `server-only`, the database and S3 so it can be unit tested.
 * The server actions in `src/server/file-upload-actions.ts` load the session
 * and membership and then apply these rules.
 */

/** Key prefixes a signed-in company member may upload to the private bucket. */
export const CLIENT_PRIVATE_KEY_PREFIXES = [
  "new-safes",
  "existing-safes",
  "unsigned-esign-doc",
  "stock-option-docs",
  "generic-documents",
  "shares-docs",
] as const;

/** Key prefixes a signed-in user may upload to the public bucket. */
export const CLIENT_PUBLIC_KEY_PREFIXES = [
  "company-logos",
  "profile-avatars",
] as const;

/** Mirrors `validateFile` in `src/lib/utils.ts` used by the image pickers. */
export const PUBLIC_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

const DATA_ROOM_PREFIX = /^data-room\/([A-Za-z0-9_-]{1,64})$/;

export type UploadAuthorizationRequest = {
  bucketMode: "privateBucket" | "publicBucket";
  keyPrefix: string;
  identifier: string;
  contentType: string;
};

export type UploadAuthorizationSubject = {
  userId: string;
  /** null when the user has no ACTIVE membership (e.g. during onboarding). */
  company: { id: string; publicId: string } | null;
};

export type UploadAuthorizationResult =
  | { ok: true; dataRoomPublicId?: string }
  | { ok: false; reason: string };

/**
 * Decides whether a presigned PUT may be issued. Data-room prefixes are
 * returned so the caller can confirm the data room belongs to the company.
 */
export function authorizeUpload(
  subject: UploadAuthorizationSubject,
  req: UploadAuthorizationRequest,
): UploadAuthorizationResult {
  if (!subject.userId) {
    return { ok: false, reason: "not signed in" };
  }

  if (req.bucketMode === "publicBucket") {
    if (
      !(CLIENT_PUBLIC_KEY_PREFIXES as readonly string[]).includes(req.keyPrefix)
    ) {
      return { ok: false, reason: "key prefix not allowed" };
    }
    // Logos and avatars are namespaced by the uploading user (the company
    // may not exist yet during onboarding).
    if (req.identifier !== subject.userId) {
      return { ok: false, reason: "identifier not allowed" };
    }
    if (
      !(PUBLIC_IMAGE_CONTENT_TYPES as readonly string[]).includes(
        req.contentType,
      )
    ) {
      return { ok: false, reason: "content type not allowed" };
    }
    return { ok: true };
  }

  if (req.bucketMode !== "privateBucket") {
    return { ok: false, reason: "bucket not allowed" };
  }

  const company = subject.company;
  if (!company || !company.publicId) {
    return { ok: false, reason: "no active company membership" };
  }
  if (req.identifier !== company.publicId) {
    return { ok: false, reason: "identifier not allowed" };
  }

  if (
    (CLIENT_PRIVATE_KEY_PREFIXES as readonly string[]).includes(req.keyPrefix)
  ) {
    return { ok: true };
  }

  const dataRoom = DATA_ROOM_PREFIX.exec(req.keyPrefix);
  if (dataRoom?.[1]) {
    return { ok: true, dataRoomPublicId: dataRoom[1] };
  }

  return { ok: false, reason: "key prefix not allowed" };
}

/**
 * Object keys a company may read from the private bucket. Keys are built as
 * `${identifier}/${keyPrefix}-...` where identifier is the company publicId
 * (browser uploads), the internal company id (signed e-sign documents) or
 * `templates` (copies of the bundled, public YC SAFE templates).
 */
export function isKeyInCompanyNamespace(
  key: string,
  company: { id: string; publicId: string },
): boolean {
  if (!key || key.includes("..") || key.startsWith("/")) {
    return false;
  }

  const namespaces = [
    company.publicId ? `${company.publicId}/` : null,
    company.id ? `${company.id}/` : null,
    "templates/new-safes-",
  ].filter((ns): ns is string => !!ns);

  return namespaces.some((ns) => key.startsWith(ns));
}
