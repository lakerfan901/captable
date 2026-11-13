// ASSUMPTION: in production the app sits behind a reverse proxy that
// OVERWRITES `X-Forwarded-For` (it does not append to a client-supplied
// value), so its leftmost entry is the real client address. Without such a
// proxy the value is client-controlled: callers that store it (ballot and
// resolution evidence) bound its length and escape it on export, and it must
// never be used for authorization.
export function getIp(headers: Headers) {
  const FALLBACK_IP_ADDRESS = "127.0.0.1";
  const forwardedFor = headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor
      ? Array.isArray(forwardedFor)
        ? (forwardedFor[0] as string)
        : (forwardedFor.split(",")[0] ?? FALLBACK_IP_ADDRESS)
      : FALLBACK_IP_ADDRESS;
  }

  return headers.get("x-real-ip") ?? FALLBACK_IP_ADDRESS;
}

export function getUserAgent(headers: Headers) {
  return headers.get("user-agent") ?? "";
}
