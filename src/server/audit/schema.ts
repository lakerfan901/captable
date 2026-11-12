import { z } from "zod";

export const AuditSchema = z.object({
  companyId: z.string(),
  action: z.enum([
    "user.signed-up",
    "user.onboarded",
    "user.verified",
    "user.password-updated",

    "company.created",
    "company.updated",

    "member.invited",
    "member.re-invited",
    "member.accepted",
    "member.updated",
    "member.removed",
    "member.revoked-invite",
    "member.deactivated",
    "member.activated",

    "stakeholder.added",
    "stakeholder.updated",
    "stakeholder.deleted",

    "shareClass.created",
    "shareClass.updated",
    "shareClass.deleted",

    "equityPlan.created",
    "equityPlan.updated",
    "equityPlan.deleted",

    "document.created",
    "document.deleted",

    "option.created",
    "option.deleted",

    "share.created",
    "share.updated",
    "share.deleted",

    "safe.created",
    "safe.imported",
    "safe.sent",
    "safe.signed",
    "safe.deleted",

    "documentShare.created",

    "password.updated",

    "update.created",
    "update.updated",
    "update.cloned",
    "update.shared",
    "update.unshared",

    "accessToken.created",
    "accessToken.deleted",

    "bucket.created",

    "dataroom.created",
    "dataroom.updated",
    "dataroom.shared",
    "dataroom.deleted",

    "role.created",
    "role.updated",
    "role.deleted",

    "template.updated",
    "template.created",

    "passkey.created",
    "passkey.deleted",
    "passkey.updated",

    "company.entity-type-changed",
    "unitClass.updated",
    "commitment.created",
    "commitment.updated",
    "commitment.accepted",
    "commitment.reduced",
    "commitment.rejected",
    "commitment.refund-recorded",
    "capitalReceipt.recorded",
    "capitalReceipt.voided",
    "capitalReceipt.start-date-changed",
    "stakeholder.admitted",
    "stakeholder.imported",
    "document.attached",
    "admission.master-created",
    "admission.sent",
    "admission.confirmed",
    "admission.countersign-ready",
    "admission.cancelled",
    "admission.w9-received",
    "emailLog.bounce-marked",

    "resolution.created",
    "resolution.updated",
    "resolution.deleted",
    "resolution.sent",
    "resolution.approved",
    "resolution.withdrawn",
    "resolution.effective",
    "resolution.failed",
    "resolution.expired",
    "resolution.filed",
    "resolution.copy-delivered",
    "ballot.issued",
    "ballot.link-replaced",
    "ballot.link-revoked",
    "ballot.reminded",
    "ballot.submitted",
    "ballot.deemed",
    "memberReport.created",
    "memberReport.updated",
    "memberReport.deleted",
    "memberReport.sent",
    "memberReport.resent",
    "memberReport.filed",
    "compliance.created",
    "compliance.updated",
    "compliance.completed",
    "compliance.reopened",
    "unitTransfer.created",
    "unitTransfer.updated",
    "unitTransfer.completed",
    "unitTransfer.cancelled",
    "unitTransfer.admitted",
    "document.categorized",
  ]),
  occurredAt: z.date().optional(),
  actor: z.object({
    type: z.enum([
      "user",
      "company",
      "document",
      "option",
      "stakeholder",
      "system",
    ]),
    id: z.string().optional().nullable(),
  }),

  target: z.array(
    z.object({
      type: z.enum([
        "user",
        "company",
        "document",
        "option",
        "documentShare",
        "share",
        "update",
        "stakeholder",
        "accessToken",
        "bucket",
        "stripeSession",
        "stripeBillingPortalSession",
        "dataroom",
        "role",
        "template",
        "passkey",
        "unitClass",
        "commitment",
        "capitalReceipt",
        "emailLog",
        "resolution",
        "ballot",
        "memberReport",
        "complianceDeadline",
        "unitTransfer",
      ]),
      id: z.string().optional().nullable(),
    }),
  ),

  context: z.object({
    requestIp: z.string(),
    userAgent: z.string(),
  }),

  summary: z.string().optional(),
});

export type AuditSchemaType = z.infer<typeof AuditSchema>;

export const getActions = () => {
  const actions = AuditSchema.shape.action.enum;
  return Object.values(actions).map((action) => ({
    label: action,
    value: action,
  }));
};

export const EsignAuditSchema = z.object({
  action: z.enum([
    "document.complete",
    "recipient.signed",
    "document.email.sent",
  ]),
  occurredAt: z.date().optional(),
  templateId: z.string(),
  recipientId: z.string().optional(),
  companyId: z.string(),
  ip: z.string(),
  userAgent: z.string(),
  location: z.string(),
  summary: z.string(),
});

export type TEsignAuditSchema = z.infer<typeof EsignAuditSchema>;
