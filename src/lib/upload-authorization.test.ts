import { describe, expect, test } from "vitest";
import {
  type UploadAuthorizationRequest,
  type UploadAuthorizationSubject,
  authorizeUpload,
  isKeyInCompanyNamespace,
} from "./upload-authorization";

const companyA = { id: "cmp_a_internal", publicId: "acme" };
const companyB = { id: "cmp_b_internal", publicId: "globex" };

const memberOfA: UploadAuthorizationSubject = {
  userId: "user_a",
  company: companyA,
};
const onboardingUser: UploadAuthorizationSubject = {
  userId: "user_new",
  company: null,
};

const req = (
  overrides: Partial<UploadAuthorizationRequest>,
): UploadAuthorizationRequest => ({
  bucketMode: "privateBucket",
  keyPrefix: "generic-documents",
  identifier: companyA.publicId,
  contentType: "application/pdf",
  ...overrides,
});

describe("authorizeUpload", () => {
  const cases: {
    name: string;
    subject: UploadAuthorizationSubject;
    request: UploadAuthorizationRequest;
    ok: boolean;
    dataRoomPublicId?: string;
  }[] = [
    {
      name: "member uploads a private document for their company",
      subject: memberOfA,
      request: req({}),
      ok: true,
    },
    {
      name: "member cannot upload under another company's publicId",
      subject: memberOfA,
      request: req({ identifier: companyB.publicId }),
      ok: false,
    },
    {
      name: "member cannot upload under their company's internal id",
      subject: memberOfA,
      request: req({ identifier: companyA.id }),
      ok: false,
    },
    {
      name: "member cannot use the server-only signed e-sign prefix",
      subject: memberOfA,
      request: req({ keyPrefix: "signed-esign-doc" }),
      ok: false,
    },
    {
      name: "member cannot use the templates identifier",
      subject: memberOfA,
      request: req({ identifier: "templates", keyPrefix: "new-safes" }),
      ok: false,
    },
    {
      name: "unknown prefix is rejected",
      subject: memberOfA,
      request: req({ keyPrefix: "anything" }),
      ok: false,
    },
    {
      name: "data room prefix is returned for an ownership check",
      subject: memberOfA,
      request: req({ keyPrefix: "data-room/room_123" }),
      ok: true,
      dataRoomPublicId: "room_123",
    },
    {
      name: "data room prefix with path tricks is rejected",
      subject: memberOfA,
      request: req({ keyPrefix: "data-room/../globex" }),
      ok: false,
    },
    {
      name: "user without membership cannot upload private documents",
      subject: onboardingUser,
      request: req({ identifier: "" }),
      ok: false,
    },
    {
      name: "unauthenticated caller is rejected",
      subject: { userId: "", company: null },
      request: req({}),
      ok: false,
    },
    {
      name: "onboarding user uploads a company logo under their user id",
      subject: onboardingUser,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "company-logos",
        identifier: "user_new",
        contentType: "image/png",
      }),
      ok: true,
    },
    {
      name: "member uploads an avatar under their user id",
      subject: memberOfA,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "profile-avatars",
        identifier: "user_a",
        contentType: "image/webp",
      }),
      ok: true,
    },
    {
      name: "public upload under someone else's user id is rejected",
      subject: memberOfA,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "profile-avatars",
        identifier: "user_b",
        contentType: "image/png",
      }),
      ok: false,
    },
    {
      name: "public upload of html is rejected",
      subject: memberOfA,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "company-logos",
        identifier: "user_a",
        contentType: "text/html",
      }),
      ok: false,
    },
    {
      name: "public upload of svg is rejected",
      subject: memberOfA,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "company-logos",
        identifier: "user_a",
        contentType: "image/svg+xml",
      }),
      ok: false,
    },
    {
      name: "documents cannot be written to the public bucket",
      subject: memberOfA,
      request: req({
        bucketMode: "publicBucket",
        keyPrefix: "generic-documents",
        identifier: "user_a",
        contentType: "image/png",
      }),
      ok: false,
    },
  ];

  test.each(cases)("$name", ({ subject, request, ok, dataRoomPublicId }) => {
    const result = authorizeUpload(subject, request);
    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.dataRoomPublicId).toBe(dataRoomPublicId);
    }
  });
});

describe("isKeyInCompanyNamespace", () => {
  test.each([
    ["acme/generic-documents-report-abc123.pdf", true],
    ["cmp_a_internal/signed-esign-doc-safe-abc123.pdf", true],
    ["templates/new-safes-post-money-abc123.pdf", true],
    ["globex/generic-documents-report-abc123.pdf", false],
    ["cmp_b_internal/signed-esign-doc-safe-abc123.pdf", false],
    ["acmecorp/generic-documents-report-abc123.pdf", false],
    ["acme/../globex/generic-documents-x.pdf", false],
    ["/acme/generic-documents-x.pdf", false],
    ["templates/other-thing.pdf", false],
    ["", false],
  ])("%s -> %s", (key, expected) => {
    expect(isKeyInCompanyNamespace(key, companyA)).toBe(expected);
  });
});
