import { z } from "zod";
import { PORTAL_EMAIL_MAX_LENGTH } from "@/lib/portal/visibility-core";

// Inputs of the portal access admin procedures (04-investor-portal.md 5.6;
// package P3). Every id is resolved on the server together with the
// caller's company (`{ id | publicId, companyId }`). No input carries a
// password, a token or a company id.

const ZStakeholderId = z.string().trim().min(1).max(64);

/** `PortalAccess.publicId`. */
export const ZAccessId = z.string().trim().min(8).max(64);

export const ZAccessForHolderInput = z
  .object({ stakeholderId: ZStakeholderId })
  .strict();

export const ZInviteInput = z
  .object({
    stakeholderId: ZStakeholderId,
    email: z.string().trim().min(3).max(PORTAL_EMAIL_MAX_LENGTH),
    name: z.string().trim().max(200).optional(),
  })
  .strict();

export const ZAccessRefInput = z.object({ accessId: ZAccessId }).strict();

export const ZSetAccessStatusInput = z
  .object({
    accessId: ZAccessId,
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .strict();

export type TInviteInput = z.infer<typeof ZInviteInput>;
export type TSetAccessStatusInput = z.infer<typeof ZSetAccessStatusInput>;
