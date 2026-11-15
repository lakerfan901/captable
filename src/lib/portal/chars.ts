// Character checks shared by the portal cores (package P1). Pure.

/**
 * True when `value` contains a C0 or C1 control character, DEL, a line or
 * paragraph separator (U+2028, U+2029), or a lone surrogate. Iterating with
 * `for…of` yields a well-formed surrogate pair as one code point (above
 * U+FFFF) and a lone surrogate as itself, so only the lone ones match.
 */
export function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f) return true;
    if (cp >= 0x7f && cp <= 0x9f) return true;
    if (cp === 0x2028 || cp === 0x2029) return true;
    if (cp >= 0xd800 && cp <= 0xdfff) return true;
  }
  return false;
}
