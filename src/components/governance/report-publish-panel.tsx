"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInstant } from "@/lib/company-time";
import { type PublishState, plural } from "@/lib/governance/release-view";
import { api } from "@/trpc/react";

// "Investor portal" panel of a released report (04-investor-portal.md 6.2,
// P24; package P4c): whether the recipients can open it in the portal, with
// Unpublish / Publish to portal. Neither changes recipients, the frozen
// content or the books, and neither sends email. The buttons exist only
// with `governance: update`; the page shows the panel only with
// `portal: read` (as the approved prototype).

export function ReportPublishPanel({
  publicId,
  state,
  publishedAt,
  unpublishedAt,
  recipientCount,
  timeZone,
  canUpdate,
}: {
  publicId: string;
  state: PublishState;
  publishedAt: Date | null;
  unpublishedAt: Date | null;
  recipientCount: number;
  timeZone: string;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const publish = api.memberReport.publish.useMutation();
  const unpublish = api.memberReport.unpublish.useMutation();
  const busy = publish.isPending || unpublish.isPending;

  const run = async (which: "publish" | "unpublish") => {
    try {
      if (which === "publish") {
        await publish.mutateAsync({ publicId });
        toast.success(
          `Published to the investor portal for ${plural(recipientCount, "holder", "holders")}.`,
        );
      } else {
        await unpublish.mutateAsync({ publicId });
        toast.success("Unpublished. The portal no longer lists this report.");
      }
      router.refresh();
    } catch (e) {
      toast.error(
        e instanceof Error && e.message ? e.message : "Something went wrong.",
      );
    }
  };

  let badge: React.ReactNode;
  let text: string;
  let action: "publish" | "unpublish" | null = null;
  switch (state) {
    case "PUBLISHED":
      badge = <Badge variant="success">Published</Badge>;
      text = `Published ${formatInstant(publishedAt, timeZone)}. The ${plural(recipientCount, "holder", "holders")} on the recipient list can open it in the portal.`;
      action = "unpublish";
      break;
    case "UNPUBLISHED":
      badge = <Badge variant="warning">Unpublished</Badge>;
      text = `Unpublished ${formatInstant(unpublishedAt, timeZone)}. Emailed links show “This report is no longer available.” Nothing can be emailed until it is published again.`;
      action = "publish";
      break;
    case "NEVER":
      badge = <Badge variant="secondary">Not published</Badge>;
      text =
        "Not published (sent before the portal). Emailed links open the read-only page as before.";
      action = "publish";
      break;
    default:
      badge = <Badge variant="secondary">Not released</Badge>;
      text = "Releasing publishes the report to the holders you pick.";
  }

  return (
    <Card data-testid="portal-panel">
      <CardHeader>
        <CardTitle className="text-base">Investor portal</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {badge}
            <span className="text-sm text-muted-foreground">{text}</span>
          </div>
          {canUpdate && action ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              loading={busy}
              onClick={() => void run(action)}
            >
              {action === "publish" ? "Publish to portal" : "Unpublish"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
