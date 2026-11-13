import { z } from "zod";

// Inputs of the public ballot router (03-governance.md G8). Client-safe: zod
// only, so the public ballot page (G11) may import these.
//
// Everything here is attacker-controlled. Objects are strict (no extra keys),
// every string is bounded, and the token is the ONLY identifier accepted: no
// ballot, resolution, stakeholder or company id is ever taken from the client.
// Messages never echo the input (the token must not appear in an error).

const INVALID_LINK = "Invalid link.";

export const zBallotToken = z
  .string({ error: INVALID_LINK })
  .min(20, INVALID_LINK)
  .max(2048, INVALID_LINK);

export const ZBallotTokenSchema = z.object({ token: zBallotToken }).strict();

export const BALLOT_CHOICES = ["FOR", "AGAINST", "ABSTAIN"] as const;
export type BallotChoice = (typeof BALLOT_CHOICES)[number];

// The typed signature is plain text: no markup characters and no control
// characters (it is rendered as text on the page and in the PDF, never as
// HTML; rejecting `<`/`>` keeps it inert in every other sink too).
// Rejected: `<`, `>`, control characters (C0, DEL, C1) and the Unicode line
// and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const NO_MARKUP = "Use letters, spaces and punctuation only.";

export const ZBallotSubmitSchema = z
  .object({
    token: zBallotToken,
    choice: z.enum(BALLOT_CHOICES, {
      error: "Choose For, Against or Abstain.",
    }),
    signedName: z
      .string()
      .trim()
      .min(2, "Type your full legal name.")
      .max(200)
      .refine((s) => !UNSAFE_TEXT.test(s), NO_MARKUP),
    signerCapacity: z
      .string()
      .trim()
      .max(200)
      .refine((s) => !UNSAFE_TEXT.test(s), NO_MARKUP)
      .optional(),
    /** The `frozenHash` the page was shown (sha256 hex). */
    bodyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "The document changed. Reload the page."),
    assent: z.literal(true, {
      error: "Confirm that you sign this response electronically.",
    }),
  })
  .strict();

export type TBallotSubmitInput = z.infer<typeof ZBallotSubmitSchema>;
