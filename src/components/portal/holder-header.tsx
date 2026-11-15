import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  companyInitials,
  holderOptionLabel,
  type PortalHolderOption,
} from "@/lib/portal/portal-nav";
import { HolderSwitcher } from "./holder-switcher";

// The holder header under `/portal/[access]` (approved prototype; package
// P8a): the company's logo and name, the holder's name, and the "Viewing"
// switcher when the person has more than one holder. Server component; the
// switcher receives only access ids and labels.

export function HolderHeader(props: {
  current: PortalHolderOption & { companyLogo: string | null };
  holders: PortalHolderOption[];
}) {
  const { current, holders } = props;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="h-12 w-12 rounded">
          {current.companyLogo ? (
            <AvatarImage src={current.companyLogo} alt="" />
          ) : null}
          <AvatarFallback className="rounded bg-indigo-100 font-medium text-indigo-700">
            {companyInitials(current.companyName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p
            className="truncate text-sm text-muted-foreground"
            id="company-name"
          >
            {current.companyName}
          </p>
          <h1
            className="truncate text-2xl font-semibold tracking-tight"
            id="holder-name"
          >
            {current.holderName}
          </h1>
        </div>
      </div>
      {holders.length > 1 ? (
        <HolderSwitcher
          current={current.access}
          options={holders.map((h) => ({
            access: h.access,
            label: holderOptionLabel(h, holders),
          }))}
        />
      ) : null}
    </div>
  );
}
