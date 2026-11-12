import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";

type StatCardProps = {
  title: string;
  value: ReactNode;
  /** 0–10,000 basis points; renders a progress bar when set. */
  progressBps?: number | null;
  children?: ReactNode;
};

export function StatCard({
  title,
  value,
  progressBps,
  children,
}: StatCardProps) {
  const width =
    progressBps === null || progressBps === undefined
      ? null
      : Math.min(100, Math.max(0, progressBps / 100));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="font-medium">{title}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-y-2">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {width !== null ? (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={width}
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${width}%` }}
            />
          </div>
        ) : null}
        {children ? (
          <div className="flex flex-col gap-y-1 text-sm text-muted-foreground">
            {children}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
