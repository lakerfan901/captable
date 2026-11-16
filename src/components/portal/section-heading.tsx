import type { ReactNode } from "react";

// The heading of a holder section page (Reports, Documents; package P8b),
// in the layout of the app's page header and the approved prototype. The
// holder's name is already the page's h1 (holder header), so this is an h2.

export function PortalSectionHeading(props: {
  title: string;
  /** id of the h2, for the section's aria-labelledby. */
  id?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h2 id={props.id} className="text-lg font-semibold tracking-tight">
          {props.title}
        </h2>
        {props.description ? (
          <p className="text-sm text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.action ? <div>{props.action}</div> : null}
    </div>
  );
}
