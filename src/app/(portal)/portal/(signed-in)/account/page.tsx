import { ChangePasswordForm } from "@/components/portal/password-form";
import { requirePortalMe } from "@/components/portal/portal-me";
import { PortalShell } from "@/components/portal/portal-shell";
import { Card } from "@/components/ui/card";

// /portal/account (04-investor-portal.md 5.2 "Change password", 6.1;
// package P8a): change the password by giving the current one
// (`portal.changePassword`). Same policy and messages as the set-password
// page. A wrong current password counts toward the lock, and a wrong
// password and a locked account get one message (5.2). On success the other
// sessions of the account end; this one stays signed in.

export default async function PortalAccountPage() {
  const me = await requirePortalMe();
  return (
    <PortalShell email={me.email} current="account">
      <div className="flex flex-col gap-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Change password
        </h1>
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="break-all">{me.email}</span>
        </p>
        <Card className="mt-3 w-full max-w-md p-6">
          <ChangePasswordForm email={me.email} />
        </Card>
      </div>
    </PortalShell>
  );
}
