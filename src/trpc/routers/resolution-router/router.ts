import { createTRPCRouter } from "@/trpc/api/trpc";
import { resendNoticeProcedure } from "./procedures/resend-notice";

export const resolutionRouter = createTRPCRouter({
  resendNotice: resendNoticeProcedure,
});
