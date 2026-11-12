import type { Metadata } from "next";
import { EmailLogTable } from "@/components/llc/email/email-log-table";
import { MailCatcherBanner } from "@/components/llc/email/mail-catcher-banner";
import { TestEmailButton } from "@/components/llc/email/test-email-button";
import { Card } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Email log",
};

// Not LLC-only (F10): the email log also works for corporations.
export default async function EmailsPage() {
  const { allow } = await serverAccessControl();
  const firstPage = await allow(api.emailLog.list({ take: 50 }), [
    "emails",
    "read",
  ]);

  if (!firstPage) {
    return <UnAuthorizedState />;
  }

  const deliveryStatus = await api.emailLog.deliveryStatus();
  const testButton = allow(<TestEmailButton />, ["emails", "create"], null);

  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Email log</h3>
          <p className="text-sm text-muted-foreground">
            Notice by email is effective when sent unless you learn it was not
            delivered (Section 13.6). Record bounces here.
          </p>
        </div>
        <div>{testButton}</div>
      </div>

      {deliveryStatus.mailCatcher ? <MailCatcherBanner /> : null}

      <Card className="mx-auto mt-3 w-md sm:w-152 md:w-full">
        <EmailLogTable initialData={firstPage} />
      </Card>
    </div>
  );
}
