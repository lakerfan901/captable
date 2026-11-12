"use client";

import { EmailLogTable } from "@/components/llc/email/email-log-table";

export function EmailsTab({ stakeholderId }: { stakeholderId: string }) {
  return (
    <EmailLogTable
      stakeholderId={stakeholderId}
      emptyText="No emails have been sent to this member yet."
    />
  );
}
