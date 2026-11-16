/**
 * Which From address an email goes out under.
 *
 * Account and system emails (sign-in, passwords, team invitations, portal
 * invitations and "new documents" notifications) use the transactional
 * address when one is configured. Everything addressed to a Member about the
 * company (reports, notices, ballots, signing requests, …) uses the investor
 * address. With no transactional address configured, every email uses the
 * investor address, as before.
 */
const TRANSACTIONAL_PREFIXES = ["auth.", "portal.", "team."] as const;

export const isTransactionalKind = (kind: string | null | undefined) =>
  typeof kind === "string" &&
  TRANSACTIONAL_PREFIXES.some((prefix) => kind.startsWith(prefix));

export const senderAddressFor = (
  kind: string | null | undefined,
  addresses: { investor: string; transactional?: string | null },
) => {
  const transactional = addresses.transactional?.trim();
  return transactional && isTransactionalKind(kind)
    ? transactional
    : addresses.investor;
};
