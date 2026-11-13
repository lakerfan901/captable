import { TRPCError } from "@trpc/server";
import { eSignNotificationEmailJob } from "@/jobs/esign-email";
import {
  INVESTOR_ROLE,
  investorSigningEmail,
  packetStageOf,
  packetStageSelect,
} from "@/server/llc/admission";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZodPacketPublicIdSchema } from "../schema";

// admission.resend (F12): re-emits the investor's e-sign request while the
// investor has not signed. Refused while production email is the mail
// catcher (nothing would arrive). The singleton key carries the current
// minute, so a double click sends once and a later resend sends again.
export const resendProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodPacketPublicIdSchema)
  .mutation(async ({ ctx, input }) => {
    assertMailDeliverable("MEMBER_EMAIL");

    const companyId = ctx.membership.companyId;
    const user = ctx.session.user;

    const packet = await ctx.db.template.findFirst({
      where: {
        publicId: input.publicId,
        companyId,
        workflow: "SUBSCRIPTION",
        isMaster: false,
      },
      select: {
        ...packetStageSelect,
        id: true,
        name: true,
        message: true,
        company: { select: { name: true, logo: true } },
        eSignRecipient: {
          select: {
            id: true,
            role: true,
            status: true,
            email: true,
            name: true,
          },
        },
      },
    });
    if (!packet) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Subscription not found.",
      });
    }
    const investor = packet.eSignRecipient.find(
      (r) => r.role === INVESTOR_ROLE,
    );
    if (
      packet.status !== "PENDING" ||
      packetStageOf(packet) !== "AWAITING_INVESTOR" ||
      !investor
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "The signing request can only be resent while the investor has not signed.",
      });
    }

    const mail = await investorSigningEmail({
      packet,
      investor,
      sender: { name: user.name ?? null, email: user.email ?? null },
      company: packet.company,
      companyId,
      requestIp: ctx.requestIp,
      userAgent: ctx.userAgent,
    });
    const minute = new Date().toISOString().slice(0, 16);
    await eSignNotificationEmailJob.emit(mail, {
      singletonKey: `esign-notify-${packet.id}-${investor.id}-${minute}`,
    });

    return { ok: true as const };
  });
