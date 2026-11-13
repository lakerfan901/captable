import { createTRPCRouter } from "@/trpc/api/trpc";
import { advanceRouter } from "./procedures/advance";
import { expenseRouter } from "./procedures/expense";
import { loanRouter } from "./procedures/loan";
import { managerPaymentRouter } from "./procedures/manager-payment";
import { reserveRouter } from "./procedures/reserve";
import { revenueRouter } from "./procedures/revenue";
import { summaryProcedure } from "./procedures/summary";

export const llcFinancialsRouter = createTRPCRouter({
  revenue: revenueRouter,
  expense: expenseRouter,
  managerPayment: managerPaymentRouter,
  reserve: reserveRouter,
  loan: loanRouter,
  advance: advanceRouter,
  summary: summaryProcedure,
});
