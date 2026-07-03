import { timingSafeEqual } from "../shared/auth";

const SIGNATURE_VERSION = "v0";
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${SIGNATURE_VERSION}:${timestamp}:${rawBody}`),
  );
  return `${SIGNATURE_VERSION}=${hex(mac)}`;
}

/**
 * Verifies a Slack request signature per
 * https://docs.slack.dev/authentication/verifying-requests-from-slack
 *
 * `nowSeconds` is a parameter (rather than read from the clock) so callers
 * control the freshness window and tests are deterministic.
 */
export async function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds: number;
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody, nowSeconds } = args;
  if (timestamp === null || signature === null) {
    return false;
  }
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS
  ) {
    return false;
  }
  const expected = await computeSlackSignature(
    signingSecret,
    timestamp,
    rawBody,
  );
  return timingSafeEqual(expected, signature);
}
