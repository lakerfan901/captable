/**
 * "Today" for economics server code (02-economics.md E7). Pure, relative
 * imports only. Outside production, `LLC_ECONOMICS_TODAY=YYYY-MM-DD` acts as
 * a test clock; production builds ignore it.
 */
import { todayInTimeZone } from "../../../lib/date-only";
import { type IsoDate, isIsoDate } from "../../../lib/llc/dates";

export function resolveEconomicsToday(i: {
  nodeEnv: string | undefined;
  override: string | undefined;
  timeZone: string;
  now: Date;
}): IsoDate {
  const override = i.override;
  if (
    i.nodeEnv !== "production" &&
    override !== undefined &&
    isIsoDate(override)
  ) {
    return override;
  }
  return todayInTimeZone(i.timeZone, i.now);
}
