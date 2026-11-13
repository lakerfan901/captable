import "server-only";

// Readers of the content frozen at send (03-governance.md G7 step 11).
//
// After send, everything shown or sent (ballot page, ballot and result
// emails, the purchase-order copy, the executed PDF, the Manager's detail
// view) is read from `frozenContent`, never from the live `title` / `params`
// columns. `resolution.update` refuses anything but a DRAFT under the row
// lock, so the live columns should not change after send; reading the frozen
// copy keeps that true even if a future bug or a manual edit changes them.
//
// `params` is part of the frozen (and hashed) content for resolutions sent
// since it was added; for an older one the live column is the fallback (it
// was frozen by the DRAFT-only rule).

type FrozenSource = {
  status?: string;
  title: string;
  params: unknown;
  frozenContent: unknown;
};

function frozenObject(frozenContent: unknown): Record<string, unknown> | null {
  return frozenContent !== null &&
    typeof frozenContent === "object" &&
    !Array.isArray(frozenContent)
    ? (frozenContent as Record<string, unknown>)
    : null;
}

/** The title frozen at send (live title for a DRAFT or a resolution without frozen content). */
export function frozenTitle(r: Pick<FrozenSource, "title" | "frozenContent">) {
  const title = frozenObject(r.frozenContent)?.title;
  return typeof title === "string" && title.trim() !== "" ? title : r.title;
}

/** The params frozen at send (live params for a DRAFT or an older resolution). Not validated. */
export function frozenParams(
  r: Pick<FrozenSource, "params" | "frozenContent">,
): unknown {
  const frozen = frozenObject(r.frozenContent);
  return frozen !== null && "params" in frozen ? frozen.params : r.params;
}

/** `{ title, params }` to show for a resolution: the live columns for a DRAFT, the frozen ones after send. */
export function frozenView(r: FrozenSource): {
  title: string;
  params: unknown;
} {
  if (r.status === "DRAFT" || r.frozenContent === null) {
    return { title: r.title, params: r.params };
  }
  return { title: frozenTitle(r), params: frozenParams(r) };
}
