import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** One Overview economics card: a title, a headline, details and an optional link. */
export function WidgetCard({
  title,
  href,
  linkLabel,
  danger,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("flex flex-col", danger && "border-red-300")}>
      <CardHeader className="pb-2">
        <CardDescription className={cn(danger && "text-red-700")}>
          {title}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-1 text-sm">
        {children}
        {href ? (
          <Link
            href={href}
            className="mt-auto pt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {linkLabel ?? "View"}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The large figure of a card. */
export function WidgetValue({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-lg font-semibold tabular-nums", className)}>
      {children}
    </div>
  );
}

/** A secondary "label: value" line. */
export function WidgetLine({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2 text-muted-foreground">
      <span>{label}</span>
      <span className="text-foreground">{children}</span>
    </div>
  );
}
