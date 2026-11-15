"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { switchTargetPath } from "@/lib/portal/portal-nav";

// "Viewing" (04-investor-portal.md 6.1; approved prototype; package P8a):
// switches between the holders of the signed-in person. It only navigates:
// the next page resolves the chosen access against the session on the
// server, as every portal page does. The options carry the opaque access id
// and a label, nothing else.

export interface HolderSwitcherOption {
  access: string;
  label: string;
}

export function HolderSwitcher(props: {
  current: string;
  options: HolderSwitcherOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <span
        className="shrink-0 text-sm text-muted-foreground"
        id="holder-switch-label"
      >
        Viewing
      </span>
      <Select
        value={props.current}
        onValueChange={(access) => {
          if (access === props.current) return;
          startTransition(() => {
            router.push(switchTargetPath(pathname, props.current, access));
          });
        }}
      >
        <SelectTrigger
          className="w-full min-w-0 gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto sm:min-w-64 sm:max-w-md"
          aria-labelledby="holder-switch-label"
          aria-busy={pending || undefined}
          data-testid="holder-switch"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.access} value={option.access}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
