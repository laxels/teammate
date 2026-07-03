// Shared auth primitive. Lives in shared/ (not src/) because both the Convex
// side and the gateway compare shared secrets; the VM payload ships shared/.

/** Constant-time string comparison for secret/signature checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Constant-time check of a caller-supplied secret against its expected env
 * value; an unset/empty expected secret denies everything. On mismatch it
 * returns false and console.warns `warnMessage` — callers no-op rather than
 * throw, so a misconfigured client sees empty results instead of generating
 * error spam, while the warn keeps the mismatch diagnosable.
 */
export function secretMatches(
  expected: string | undefined,
  provided: string,
  warnMessage: string,
): boolean {
  const ok =
    expected !== undefined &&
    expected !== "" &&
    timingSafeEqual(provided, expected);
  if (!ok) {
    console.warn(warnMessage);
  }
  return ok;
}
