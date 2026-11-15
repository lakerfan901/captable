import Link from "next/link";
import { AuthCard } from "@/components/portal/auth-card";
import { Button } from "@/components/ui/button";

// The portal's 404 (package P8a): an unknown path, an access that is not
// the signed-in user's (another person's id, a disabled access) and a report
// or document the holder may not see all look the same (S3). No team-app
// chrome and no link into the team app.

export default function PortalNotFound() {
  return (
    <AuthCard title="Page not found">
      <p className="text-center text-sm" id="portal-not-found">
        This page does not exist or is not available to you.
      </p>
      <Button asChild>
        <Link href="/portal">Go to the portal</Link>
      </Button>
    </AuthCard>
  );
}
