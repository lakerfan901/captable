import { IsoDateText } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import type { DefaultViewWire } from "./forfeiture-dialog";

type Step = {
  key: string;
  label: string;
  date: string | null;
  done: boolean;
  note?: string;
};

/** Due date → window opens → Forfeiture Date → Credit Date → outside date, each done or pending (as of the economics `today`). */
export function DefaultTimeline({
  view,
  today,
}: {
  view: DefaultViewWire;
  today: string;
}) {
  const passed = (d: string | null) => d !== null && d <= today;
  const steps: Step[] = [
    {
      key: "due",
      label: "Due date",
      date: view.dueOn,
      done: passed(view.dueOn),
    },
    {
      key: "opens",
      label: "Replacement window opens",
      date: view.replacementWindow.opensOn,
      done: passed(view.replacementWindow.opensOn),
    },
    {
      key: "forfeiture",
      label: "Forfeiture Date",
      date: view.forfeitureDate,
      done: view.forfeiture.confirmed,
      note: view.forfeiture.confirmed
        ? "forfeiture confirmed"
        : view.forfeiture.paidInFullByForfeitureDate
          ? "paid in full by the member on or before this date"
          : undefined,
    },
    {
      key: "credit",
      label: "Credit Date",
      date: view.credit.recorded?.creditDate ?? view.credit.creditDate,
      done: view.credit.confirmed,
      note: view.credit.confirmed
        ? "credit confirmed"
        : view.forfeiture.confirmed
          ? "computed; may move earlier"
          : "after a confirmed forfeiture; may move earlier",
    },
    {
      key: "closes",
      label: "Replacement Funder outside date",
      date: view.replacementWindow.closesOn,
      done: passed(view.replacementWindow.closesOn),
    },
  ];

  return (
    <ol className="relative grid gap-4 border-l pl-6">
      {steps.map((s) => (
        <li key={s.key} className="relative">
          <span
            className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 ${
              s.done
                ? "border-primary bg-primary"
                : "border-muted-foreground bg-background"
            }`}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{s.label}</span>
            <IsoDateText date={s.date} />
            <Badge variant={s.done ? "success" : "secondary"}>
              {s.done ? "done" : "pending"}
            </Badge>
          </div>
          {s.note ? (
            <p className="text-xs text-muted-foreground">{s.note}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
