import "server-only";

import type { IsoDate } from "@/lib/llc/dates";
import { resolveEconomicsToday } from "./clock.logic";

/** Every "today" in economics server code. `LLC_ECONOMICS_TODAY` is a test clock, ignored in production. */
export function economicsToday(
  timeZone: string,
  now: Date = new Date(),
): IsoDate {
  return resolveEconomicsToday({
    nodeEnv: process.env.NODE_ENV,
    override: process.env.LLC_ECONOMICS_TODAY,
    timeZone,
    now,
  });
}
