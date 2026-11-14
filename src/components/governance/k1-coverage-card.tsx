import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RouterOutputs } from "@/trpc/shared";

type Coverage = NonNullable<RouterOutputs["memberReport"]["get"]["k1Coverage"]>;

/** One sentence for the review dialog: whether sending completes the year. */
export function k1CompletionText(
  coverage: Coverage,
  status: "DRAFT" | "SENT" | string,
): string {
  const after = coverage.holders.filter(
    (h) => !h.delivered && !h.queued && !(status === "DRAFT" && h.attachedHere),
  );
  const fy = coverage.fiscalYear;
  if (coverage.holders.length === 0) {
    return `No holder held Units during ${fy}; the FY${fy} K-1 deadlines are not closed by this report.`;
  }
  return after.length === 0
    ? `After this, every holder of Units during ${fy} has a Schedule K-1: the FY${fy} K-1 deadlines are marked done once the last email has gone out.`
    : `The FY${fy} K-1 deadlines stay open until every holder of Units during ${fy} has received a K-1 (Section 8.2). Still without one: ${after.map((h) => h.name).join(", ")}.`;
}

/**
 * Schedule K-1 delivery for a fiscal year (R25, R22a): every holder that held
 * Units at any time during the year, and whether it has received its K-1.
 * The year's K-1 deadlines are done only when all have.
 */
export function K1CoverageCard({
  coverage,
  status,
}: {
  coverage: Coverage;
  status: "DRAFT" | "SENT" | string;
}) {
  const delivered = coverage.holders.filter((h) => h.delivered).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          FY{coverage.fiscalYear} K-1 delivery
        </CardTitle>
        <CardDescription>
          {delivered} of {coverage.holders.length} holders of Units during{" "}
          {coverage.fiscalYear} have received a Schedule K-1 (email accepted by
          the mail server). The FY{coverage.fiscalYear} K-1 deadlines are done
          only when all have (Section 8.2).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {coverage.holders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No holder held Units during {coverage.fiscalYear}.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {coverage.holders.map((h) => (
              <li
                key={h.stakeholderId}
                className="flex items-center justify-between gap-2"
              >
                <span>{h.name}</span>
                {h.delivered ? (
                  <Badge variant="success">Delivered</Badge>
                ) : h.queued ? (
                  <Badge variant="info">Email queued</Badge>
                ) : h.attachedHere ? (
                  <Badge variant="warning">
                    {status === "DRAFT"
                      ? "Sent with this report"
                      : "Attached, re-send to deliver"}
                  </Badge>
                ) : (
                  <Badge variant="destructive">No K-1 yet</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
