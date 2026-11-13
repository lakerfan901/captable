import addressparser from "nodemailer/lib/addressparser";

// The From header of every app email (M6). The display name is often a
// company name typed by a user: it must never be able to change the sender
// ADDRESS or add a header. So the address always comes from EMAIL_FROM, the
// name is cleaned here, and the pair is handed to nodemailer as an object
// (`{ name, address }`), which quotes / encodes the name itself. Never build
// `${name} <${address}>` by hand: nodemailer re-parses that string, and a
// name containing `<…>`, `:` or `,` becomes another address or a group.

const MAX_NAME_LENGTH = 100;
const DEFAULT_NAME = "Captable";

/** The bare address of EMAIL_FROM, which may be "addr" or "Name <addr>". */
export function senderAddress(emailFrom: string): {
  name: string;
  address: string;
} {
  const [first] = addressparser(emailFrom, { flatten: true });
  const address = first?.address?.trim() ?? "";
  if (address === "") {
    throw new Error("EMAIL_FROM does not contain an email address");
  }
  return { name: first?.name?.trim() ?? "", address };
}

/** Removes control characters (CR, LF, TAB, …), collapses whitespace, caps the length. */
export function cleanDisplayName(raw: string | null | undefined): string {
  return (
    (raw ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LENGTH)
      .trim()
  );
}

/**
 * `{ name, address }` for nodemailer's `from`: the address of EMAIL_FROM and
 * the cleaned `senderName` (falling back to EMAIL_FROM's own name, then
 * "Captable").
 */
export function buildFrom(
  senderName: string | null | undefined,
  emailFrom: string,
): { name: string; address: string } {
  const sender = senderAddress(emailFrom);
  const name =
    cleanDisplayName(senderName) ||
    cleanDisplayName(sender.name) ||
    DEFAULT_NAME;
  return { name, address: sender.address };
}
