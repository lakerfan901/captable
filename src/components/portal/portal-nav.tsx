"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavKey, type PortalNavItem } from "@/lib/portal/portal-nav";
import { cn } from "@/lib/utils";

// The tab row of one holder (04-investor-portal.md 6.1, 6.3; package P8a):
// plain links styled as the UI kit's tabs, the current one marked with
// `aria-current="page"`. The items come from the server (`portalNavItems`):
// only sections whose page exists, so nothing is a dead link or greyed out.
// With fewer than two items there is nothing to choose and no row is shown.

export function PortalNav(props: { items: PortalNavItem[] }) {
  const pathname = usePathname();
  if (props.items.length < 2) return null;
  const active = activeNavKey(pathname, props.items);
  return (
    <nav aria-label="Sections" className="max-w-full overflow-x-auto">
      <ul className="inline-flex h-10 items-center rounded-md bg-muted p-1 text-muted-foreground">
        {props.items.map((item) => {
          const current = item.key === active;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                data-state={current ? "active" : "inactive"}
                className={cn(
                  "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  current && "bg-background text-foreground shadow-xs",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
