import "server-only";

import type { Prisma } from "@prisma/client";
import slugify from "@sindresorhus/slugify";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { generatePublicId } from "@/common/id";
import { env } from "@/env";
import type { TESignNotificationEmailJobInput } from "@/jobs/esign-email";
import {
  type PacketCommitmentStatus,
  type PacketRecipientStatus,
  type PacketStage,
  type PacketTemplateStatus,
  packetStage,
} from "@/lib/admission/packet-stage";
import { decode, encodeWithExpiry } from "@/lib/jwt";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { EncodeEmailToken } from "@/trpc/routers/template-field-router/procedures/add-fields";

// Exhibit B packets (01-foundation.md F12, B22–B26): masters are cloned into
// single-use envelopes; after the investor signs, a W-9 link (its own token
// kind) lets them upload a W-9 without a login.

export type { PacketStage };
export { packetStage };

export const INVESTOR_ROLE = "investor";
export const MANAGER_ROLE = "manager";

// ---------------------------------------------------------------------------
// Stage

type StageSource = {
  status: PacketTemplateStatus;
  commitment: { status: PacketCommitmentStatus } | null;
  eSignRecipient: { role: string | null; status: PacketRecipientStatus }[];
};

/** The stage of a packet loaded with `commitment.status` and its recipients' role and status. */
export function packetStageOf(template: StageSource): PacketStage {
  const role = (r: string) =>
    template.eSignRecipient.find((x) => x.role === r)?.status ?? null;
  return packetStage({
    templateStatus: template.status,
    investorStatus: role(INVESTOR_ROLE),
    managerStatus: role(MANAGER_ROLE),
    commitmentStatus: template.commitment?.status ?? null,
  });
}

export const packetStageSelect = {
  status: true,
  commitment: { select: { status: true } },
  eSignRecipient: { select: { role: true, status: true } },
} as const;

/**
 * Row lock on the template (SELECT … FOR UPDATE). Signing, cancelling and
 * W-9 registration of a packet serialise on it; `completeEsignDocuments`
 * takes the same lock. Take it after any company or unit-class lock.
 */
export async function lockTemplate(
  tx: PrismaTransactionalClient,
  templateId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Template" WHERE id = ${templateId} FOR UPDATE`;
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Clone

export const masterSelect = {
  id: true,
  publicId: true,
  name: true,
  bucketId: true,
  companyId: true,
  fields: true,
  eSignRecipient: { select: { id: true, role: true } },
} as const;

export type MasterForClone = Prisma.TemplateGetPayload<{
  select: typeof masterSelect;
}>;

export function masterFieldRoles(master: MasterForClone) {
  const roleOf = new Map(master.eSignRecipient.map((r) => [r.id, r.role]));
  return master.fields.map((field) => ({
    semanticKey: field.semanticKey,
    role: roleOf.get(field.recipientId) ?? null,
  }));
}

export interface ClonePacketInput {
  master: MasterForClone;
  companyId: string;
  uploaderMemberId: string;
  stakeholder: {
    id: string;
    name: string;
    email: string;
    noticeEmail: string | null;
  };
  manager: { memberId: string; name: string; email: string };
  message?: string | null;
}

/**
 * Master + role recipients → a single-use envelope (B22): a new PENDING
 * template on the master's bucket, one investor and one manager recipient
 * (both PENDING; the e-sign email worker marks the investor SENT), and a copy
 * of every master field on the recipient with the same role. Answers are
 * cleared; every other column (semantic key, meta, geometry, required,
 * read-only, default) is kept as it is.
 */
export async function cloneMasterToPacket(
  tx: PrismaTransactionalClient,
  input: ClonePacketInput,
) {
  const { master, companyId, stakeholder, manager } = input;
  const roleOf = new Map(master.eSignRecipient.map((r) => [r.id, r.role]));

  for (const field of master.fields) {
    const role = roleOf.get(field.recipientId);
    if (role !== INVESTOR_ROLE && role !== MANAGER_ROLE) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "The master has a field that is not assigned to the investor or the Manager. Edit the master's fields first.",
      });
    }
  }

  const packet = await tx.template.create({
    data: {
      name: `${master.name} — ${stakeholder.name}`,
      publicId: generatePublicId(),
      status: "PENDING",
      bucketId: master.bucketId,
      uploaderId: input.uploaderMemberId,
      companyId,
      workflow: "SUBSCRIPTION",
      isMaster: false,
      sourceTemplateId: master.id,
      stakeholderId: stakeholder.id,
      orderedDelivery: true,
      message: input.message ?? null,
    },
    select: { id: true, publicId: true, name: true, message: true },
  });

  // Created one after the other: signing order 1, then 2 (A3.9).
  const investor = await tx.esignRecipient.create({
    data: {
      templateId: packet.id,
      email: stakeholder.noticeEmail ?? stakeholder.email,
      name: stakeholder.name,
      role: INVESTOR_ROLE,
      signingOrder: 1,
      stakeholderId: stakeholder.id,
      status: "PENDING",
    },
    select: { id: true, email: true, name: true },
  });
  const managerRecipient = await tx.esignRecipient.create({
    data: {
      templateId: packet.id,
      email: manager.email,
      name: manager.name,
      memberId: manager.memberId,
      role: MANAGER_ROLE,
      signingOrder: 2,
      status: "PENDING",
    },
    select: { id: true, email: true, name: true },
  });

  const recipientFor = (masterRecipientId: string) =>
    roleOf.get(masterRecipientId) === INVESTOR_ROLE
      ? investor.id
      : managerRecipient.id;

  if (master.fields.length > 0) {
    await tx.templateField.createMany({
      data: master.fields.map((field) => ({
        name: field.name,
        type: field.type,
        defaultValue: field.defaultValue,
        readOnly: field.readOnly,
        required: field.required,
        prefilledValue: null,
        top: field.top,
        left: field.left,
        width: field.width,
        height: field.height,
        viewportHeight: field.viewportHeight,
        viewportWidth: field.viewportWidth,
        page: field.page,
        meta: field.meta,
        semanticKey: field.semanticKey,
        templateId: packet.id,
        recipientId: recipientFor(field.recipientId),
      })),
    });
  }

  return { packet, investor, manager: managerRecipient };
}

/** The e-sign request email for the packet's investor (same payload as `add-fields.ts`). */
export async function investorSigningEmail(input: {
  packet: { id: string; name: string; message: string | null };
  investor: { id: string; email: string; name: string | null };
  sender: { name: string | null; email: string | null };
  company: { name: string; logo: string | null };
  companyId: string;
  requestIp: string;
  userAgent: string;
}): Promise<TESignNotificationEmailJobInput> {
  const token = await EncodeEmailToken({
    templateId: input.packet.id,
    recipientId: input.investor.id,
  });
  return {
    token,
    email: input.investor.email,
    recipient: {
      id: input.investor.id,
      name: input.investor.name,
      email: input.investor.email,
    },
    sender: { name: input.sender.name, email: input.sender.email },
    message: input.packet.message,
    documentName: input.packet.name,
    company: { name: input.company.name, logo: input.company.logo },
    companyId: input.companyId,
    requestIp: input.requestIp,
    userAgent: input.userAgent,
  };
}

// ---------------------------------------------------------------------------
// W-9 token (B26)

export const W9_MAX_UPLOADS = 5;
export const W9_MAX_BYTES = 10 * 1024 * 1024;
export const W9_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export type W9ContentType = (typeof W9_CONTENT_TYPES)[number];
const W9_EXTENSION: Record<W9ContentType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

export const W9_LINK_INVALID = "This link is invalid or has expired.";
export const W9_FILE_REFUSED =
  "The file must be a PDF, JPEG or PNG of at most 10 MB.";
export const W9_LIMIT_REACHED =
  "The maximum number of uploads was reached. Email the Manager.";

const W9_TOKEN_PURPOSE = "w9";

// Strict: a signing token (no `p`), a ballot (`p: "rb"`) or report
// (`p: "mr"`) token never parses as a W-9 token, and the signing path
// rejects every token that has a `p` claim.
const W9TokenPayload = z.strictObject({
  p: z.literal(W9_TOKEN_PURPOSE),
  id: z.string().min(1).max(64),
  rec: z.string().min(1).max(64),
  iat: z.number().int(),
  exp: z.number().int(),
});

export function encodeW9Token(input: {
  templateId: string;
  recipientId: string;
}): Promise<string> {
  return encodeWithExpiry(
    { p: W9_TOKEN_PURPOSE, id: input.templateId, rec: input.recipientId },
    "30d",
  );
}

/** The packet and recipient a W-9 token names, or null (bad signature, expired, other kind). */
export async function decodeW9Token(
  token: string,
): Promise<{ templateId: string; recipientId: string } | null> {
  try {
    const { payload } = await decode(token);
    const parsed = W9TokenPayload.safeParse(payload);
    if (!parsed.success) return null;
    return { templateId: parsed.data.id, recipientId: parsed.data.rec };
  } catch {
    return null;
  }
}

export interface W9Packet {
  templateId: string;
  templatePublicId: string;
  templateCreatedAt: Date;
  recipientId: string;
  companyId: string;
  companyPublicId: string;
  companyName: string;
  stakeholderId: string;
  stakeholderName: string;
}

/**
 * The packet behind a W-9 link, or null unless: the template is a
 * SUBSCRIPTION packet (not a master) that is PENDING or COMPLETE, of an LLC
 * company, filed on one of that company's stakeholders; the recipient
 * belongs to it, has role `investor` and has SIGNED.
 */
export async function loadW9Packet(
  db: TPrismaOrTransaction,
  ids: { templateId: string; recipientId: string },
): Promise<W9Packet | null> {
  const recipient = await db.esignRecipient.findFirst({
    where: { id: ids.recipientId, templateId: ids.templateId },
    select: {
      id: true,
      role: true,
      status: true,
      template: {
        select: {
          id: true,
          publicId: true,
          companyId: true,
          status: true,
          workflow: true,
          isMaster: true,
          createdAt: true,
          stakeholder: { select: { id: true, name: true, companyId: true } },
          company: {
            select: { publicId: true, name: true, entityType: true },
          },
        },
      },
    },
  });
  if (!recipient) return null;
  const t = recipient.template;
  if (
    recipient.role !== INVESTOR_ROLE ||
    recipient.status !== "SIGNED" ||
    t.workflow !== "SUBSCRIPTION" ||
    t.isMaster ||
    (t.status !== "PENDING" && t.status !== "COMPLETE") ||
    t.company.entityType !== "LLC" ||
    !t.company.publicId ||
    !t.stakeholder ||
    t.stakeholder.companyId !== t.companyId
  ) {
    return null;
  }
  return {
    templateId: t.id,
    templatePublicId: t.publicId,
    templateCreatedAt: t.createdAt,
    recipientId: recipient.id,
    companyId: t.companyId,
    companyPublicId: t.company.publicId,
    companyName: t.company.name,
    stakeholderId: t.stakeholder.id,
    stakeholderName: t.stakeholder.name,
  };
}

/**
 * The ONE entry point of the public W-9 procedures. Every failure (bad
 * signature, expired, another token kind, packet no longer valid) is the same
 * detail-free FORBIDDEN. The token is never logged or stored.
 */
export async function resolveW9Token(
  db: TPrismaOrTransaction,
  token: string,
): Promise<W9Packet> {
  const ids = await decodeW9Token(token);
  const packet = ids ? await loadW9Packet(db, ids) : null;
  if (!packet) {
    throw new TRPCError({ code: "FORBIDDEN", message: W9_LINK_INVALID });
  }
  return packet;
}

/** W-9 documents filed on the packet's stakeholder since the packet was sent. */
export function countW9Uploads(
  db: TPrismaOrTransaction,
  packet: Pick<W9Packet, "companyId" | "stakeholderId" | "templateCreatedAt">,
): Promise<number> {
  return db.document.count({
    where: {
      companyId: packet.companyId,
      stakeholderId: packet.stakeholderId,
      kind: "w9",
      createdAt: { gte: packet.templateCreatedAt },
    },
  });
}

/**
 * The server-chosen file name handed to `getPresignedPutUrl`: the key becomes
 * `<company publicId>/w9-docs-<packet id>-<12 random chars><ext>`, so it
 * carries no client-supplied text and names exactly one packet.
 */
export function w9UploadFileName(
  templateId: string,
  contentType: W9ContentType,
): string {
  return `${templateId}${W9_EXTENSION[contentType]}`;
}

/** The content type the key's extension stands for, or null when `key` is not a W-9 key of this packet. */
export function w9KeyContentType(
  key: string,
  packet: Pick<W9Packet, "companyPublicId" | "templateId">,
): W9ContentType | null {
  const prefix = `${packet.companyPublicId}/w9-docs-${slugify(packet.templateId)}-`;
  if (!key.startsWith(prefix)) return null;
  const match = /^[0-9a-z]{12}(\.pdf|\.jpg|\.png)$/.exec(
    key.slice(prefix.length),
  );
  if (!match) return null;
  const ext = match[1];
  return W9_CONTENT_TYPES.find((type) => W9_EXTENSION[type] === ext) ?? null;
}

export function w9UploadUrl(token: string): string {
  return `${env.NEXT_PUBLIC_BASE_URL}/w9/${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Notices after the investor signs (F12 "Emails")

export interface AdmissionNoticePayload {
  to: string;
  companyId: string;
  companyName: string;
  kind: "admission.w9-request" | "admission.signed-notice";
  subject: string;
  heading: string;
  lines: string[];
  cta: { label: string; url: string } | null;
  /** The worker mints a fresh W-9 link for this recipient (no token in the job payload). */
  w9RecipientId?: string;
  stakeholderId?: string;
  templateId: string;
}

/**
 * The two notices of B23, read inside the signing transaction: the W-9
 * request to the investor and the review notice to the Manager recipient.
 * Emitted by the caller after the transaction commits.
 */
export async function investorSignedNotices(
  tx: TPrismaOrTransaction,
  input: { templateId: string; investorRecipientId: string },
): Promise<AdmissionNoticePayload[]> {
  const template = await tx.template.findFirstOrThrow({
    where: { id: input.templateId },
    select: {
      id: true,
      publicId: true,
      companyId: true,
      stakeholderId: true,
      stakeholder: { select: { name: true } },
      company: { select: { name: true, publicId: true } },
      eSignRecipient: {
        select: { id: true, role: true, email: true, name: true },
      },
    },
  });
  const investor = template.eSignRecipient.find(
    (r) => r.id === input.investorRecipientId,
  );
  const manager = template.eSignRecipient.find((r) => r.role === MANAGER_ROLE);
  const companyName = template.company.name;
  const investorName =
    template.stakeholder?.name ?? investor?.name ?? "The investor";
  const notices: AdmissionNoticePayload[] = [];

  if (investor) {
    notices.push({
      to: investor.email,
      companyId: template.companyId,
      companyName,
      kind: "admission.w9-request",
      subject: `${companyName}: your signature page was received — please upload your Form W-9`,
      heading: "Please upload your Form W-9",
      lines: [
        `Thank you. ${companyName} has received your signed signature page. Please upload a completed IRS Form W-9 using the secure link below. Your subscription is subject to acceptance by the Manager.`,
      ],
      cta: null,
      w9RecipientId: investor.id,
      ...(template.stakeholderId
        ? { stakeholderId: template.stakeholderId }
        : {}),
      templateId: template.id,
    });
  }
  if (manager) {
    notices.push({
      to: manager.email,
      companyId: template.companyId,
      companyName,
      kind: "admission.signed-notice",
      subject: `${companyName}: ${investorName} signed the subscription — review required`,
      heading: `${investorName} signed the subscription`,
      lines: [
        "Review the answers, confirm the wire and accept, reduce or reject within 10 business days (Section 4.8).",
      ],
      cta: {
        label: "Review subscription",
        url: `${env.NEXT_PUBLIC_BASE_URL}/${template.company.publicId}/admissions/${template.publicId}`,
      },
      templateId: template.id,
    });
  }
  return notices;
}
