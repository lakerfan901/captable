import { createTRPCRouter } from "@/trpc/api/trpc";
import { coreProcedures } from "./procedures/core";
import { deliveryProcedures } from "./procedures/delivery";

export const distributionRouter = createTRPCRouter({
  ...coreProcedures,
  ...deliveryProcedures,
});
