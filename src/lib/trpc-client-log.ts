// Which failed tRPC calls the browser's logger link writes to the console
// (src/trpc/react.tsx, outside development). An expected refusal that the
// screen itself explains is not an error of the app: a release refused by
// the P38 reconciliation check (04-investor-portal.md) carries the list of
// differences in `error.data.reconciliation`, and the release dialog shows
// that list inline. Every other failure is still logged.

/** False for a refusal the UI presents as part of the flow; true otherwise. */
export function shouldLogClientError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return true;
  const reconciliation = (data as { reconciliation?: unknown }).reconciliation;
  return reconciliation === undefined || reconciliation === null;
}
