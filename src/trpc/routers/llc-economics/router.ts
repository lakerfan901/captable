import { createTRPCRouter } from "@/trpc/api/trpc";
import { overviewProcedures } from "./procedures/overview";
import { positionsProcedures } from "./procedures/positions";
import { statementProcedures } from "./procedures/statement";

export const llcEconomicsRouter = createTRPCRouter({
  ...positionsProcedures,
  ...statementProcedures,
  ...overviewProcedures,
});
