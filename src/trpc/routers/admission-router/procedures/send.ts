import { TRPCError } from "@trpc/server";
import { eSignNotificationEmailJob } from "@/jobs/esign-email";
import { OPEN_PACKET_STAGES } from "@/lib/admission/packet-stage";
import { missingSubscriptionKeys } from "@/lib/esign/subscription-fields";
import { Audit } from "@/server/audit";
import {
  cloneMasterToPacket,
  investorSigningEmail,
  masterFieldRoles,
  masterSelect,
  packetStageOf,
  packetStageSelect,
} from "@/server/llc/admission";
import { lockCompanyLedger } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZodSendSubscriptionSchema } from "../schema";

const badRequest = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

// admission.send (F12): clone a ready master into a packet for one investor
// (an existing stakeholder, or a prospect found or created by email) and
// email the investor the signing link. The Manager recipient is not emailed
// (B23): F13 activates it after acceptance.
//
// Refused up front, before anything is written, while production email is
// the bundled mail catcher: a packet whose signing link can never arrive is
// not created (same rule as Call Notices and member reports).
//
// Concurrency: the company ledger lock (taken first, as everywhere) makes
// the "one open subscription per person" check and the prospect lookup or
// creation atomic against a concurrent send.
export const sendProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["create"] } } })
  .input(ZodSendSubscriptionSchema)
  .mutation(async ({ ctx, input }) => {
    assertMailDeliverable("MEMBER_EMAIL");

    const { companyId, memberId } = ctx.membership;
    const user = ctx.session.user;

    const { packet, mail } = await ctx.db.$transaction(async (tx) => {
      await lockCompanyLedger(tx, companyId);

      const master = await tx.template.findFirst({
        where: {
          publicId: input.masterPublicId,
          companyId,
          isMaster: true,
          workflow: "SUBSCRIPTION",
          status: "DRAFT",
        },
        select: masterSelect,
      });
      if (!master) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Master not found.",
        });
      }
      const missing = missingSubscriptionKeys(masterFieldRoles(master));
      if (missing.length > 0) {
        throw badRequest(
          `The master is not ready. Place a field for: ${missing.join(", ")}.`,
        );
      }

      const preferred = await tx.unitClass.findFirst({
        where: { companyId, kind: "PREFERRED" },
        select: { id: true },
      });
      if (!preferred) {
        throw badRequest(
          "Set up the Preferred unit class before sending subscriptions.",
        );
      }

      const stakeholderSelect = {
        id: true,
        name: true,
        email: true,
        noticeEmail: true,
      } as const;
      let stakeholder: {
        id: string;
        name: string;
        email: string;
        noticeEmail: string | null;
      } | null = null;
      let createdProspect = false;
      if (input.stakeholderId !== undefined) {
        stakeholder = await tx.stakeholder.findFirst({
          where: { id: input.stakeholderId, companyId },
          select: stakeholderSelect,
        });
        if (!stakeholder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Member not found.",
          });
        }
      } else if (input.prospect) {
        stakeholder = await tx.stakeholder.findFirst({
          where: {
            companyId,
            email: { equals: input.prospect.email, mode: "insensitive" },
          },
          select: stakeholderSelect,
        });
        if (!stakeholder) {
          stakeholder = await tx.stakeholder.create({
            data: {
              companyId,
              name: input.prospect.name,
              email: input.prospect.email,
              memberStatus: "PROSPECT",
              currentRelationship: "INVESTOR",
              stakeholderType: "INDIVIDUAL",
            },
            select: stakeholderSelect,
          });
          createdProspect = true;
        }
      }
      if (!stakeholder) {
        throw badRequest(
          "Choose an existing person or enter a new one, not both.",
        );
      }

      const others = await tx.template.findMany({
        where: {
          companyId,
          stakeholderId: stakeholder.id,
          workflow: "SUBSCRIPTION",
          isMaster: false,
          status: "PENDING",
        },
        select: packetStageSelect,
      });
      if (
        others.some((other) =>
          OPEN_PACKET_STAGES.includes(packetStageOf(other)),
        )
      ) {
        throw badRequest("This person already has an open subscription.");
      }

      const manager = await tx.member.findFirst({
        where: { id: input.managerMemberId, companyId, status: "ACTIVE" },
        select: { id: true, user: { select: { name: true, email: true } } },
      });
      if (!manager) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Manager signer not found.",
        });
      }
      const managerName = manager.user.name?.trim();
      const managerEmail = manager.user.email?.trim();
      if (!managerName || !managerEmail) {
        throw badRequest(
          "The Manager signer needs a name and an email in their profile.",
        );
      }

      const cloned = await cloneMasterToPacket(tx, {
        master,
        companyId,
        uploaderMemberId: memberId,
        stakeholder,
        manager: {
          memberId: manager.id,
          name: managerName,
          email: managerEmail,
        },
        message: input.message ?? null,
      });

      await Audit.create(
        {
          action: "admission.sent",
          companyId,
          actor: { type: "user", id: user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [
            { type: "template", id: cloned.packet.id },
            { type: "stakeholder", id: stakeholder.id },
          ],
          summary: `${user.name ?? "A team member"} sent the subscription "${cloned.packet.name}" to ${stakeholder.name}${
            createdProspect ? " (new prospect)" : ""
          }; Manager signer ${managerName}`,
        },
        tx,
      );

      const company = await tx.company.findFirstOrThrow({
        where: { id: companyId },
        select: { name: true, logo: true },
      });
      const mail = await investorSigningEmail({
        packet: cloned.packet,
        investor: cloned.investor,
        sender: { name: user.name ?? null, email: user.email ?? null },
        company,
        companyId,
        requestIp: ctx.requestIp,
        userAgent: ctx.userAgent,
      });

      return { packet: cloned.packet, mail };
    });

    // After commit: the worker marks the investor SENT and emails the link.
    await eSignNotificationEmailJob.emit(mail, {
      singletonKey: `esign-notify-${packet.id}-${mail.recipient.id}`,
    });

    return { publicId: packet.publicId };
  });
