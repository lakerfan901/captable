import { Money } from "@/components/llc/money";
import { Card, CardContent } from "@/components/ui/card";

export interface TierFigures {
  tierC: number;
  tierD: number;
  tierEPreferred: number;
  tierECommon: number;
  /** Σ unpaid Preferred Return weighting tier (c); null when not known (e.g. a stored distribution without a snapshot). */
  owedC: number | null;
  /** Σ Unreturned Capital Contributions before the distribution. */
  owedD: number | null;
}

function Tier({
  label,
  section,
  paid,
  owed,
}: {
  label: string;
  section: string;
  paid: number;
  owed: number | null;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">
          {label} <span className="whitespace-nowrap">({section})</span>
        </p>
        <p className="text-lg font-semibold tabular-nums">
          <Money cents={paid} />
        </p>
        <p className="text-xs text-muted-foreground">
          {owed === null ? (
            "paid"
          ) : (
            <>
              paid of <Money cents={owed} /> owed
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/** Tier (c) / (d) / (e) Preferred 70% / (e) Common 30% of Section 5.6. */
export function TierSummary({ t }: { t: TierFigures }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tier
        label="Tier (c) Preferred Return"
        section="5.6(c)"
        paid={t.tierC}
        owed={t.owedC}
      />
      <Tier
        label="Tier (d) Return of capital"
        section="5.6(d)"
        paid={t.tierD}
        owed={t.owedD}
      />
      <Tier
        label="Tier (e) Preferred 70%"
        section="5.6(e)"
        paid={t.tierEPreferred}
        owed={null}
      />
      <Tier
        label="Tier (e) Common 30%"
        section="5.6(e)"
        paid={t.tierECommon}
        owed={null}
      />
    </div>
  );
}
