import { expect, test } from "bun:test";
import { computeSlackSignature, verifySlackSignature } from "./slack";

// Known-answer test: expected value computed independently with
// `printf 'v0:1700000000:{"type":"event_callback","event_id":"Ev123"}' | openssl dgst -sha256 -hmac "test_signing_secret"`
const SECRET = "test_signing_secret";
const TIMESTAMP = "1700000000";
const BODY = '{"type":"event_callback","event_id":"Ev123"}';
const EXPECTED_SIGNATURE =
  "v0=44c35c4d20e6a1803875ed5e10137cb49a4938c48b32d23ce01cb223988926ca";

test("computes the documented v0 HMAC-SHA256 signature", async () => {
  expect(await computeSlackSignature(SECRET, TIMESTAMP, BODY)).toBe(
    EXPECTED_SIGNATURE,
  );
});

test("accepts a valid signature within the freshness window", async () => {
  expect(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: TIMESTAMP,
      signature: EXPECTED_SIGNATURE,
      rawBody: BODY,
      nowSeconds: 1700000000 + 60,
    }),
  ).toBe(true);
});

test("rejects a tampered body", async () => {
  expect(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: TIMESTAMP,
      signature: EXPECTED_SIGNATURE,
      rawBody: `${BODY} `,
      nowSeconds: 1700000000 + 60,
    }),
  ).toBe(false);
});

test("rejects a stale timestamp (replay protection)", async () => {
  expect(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: TIMESTAMP,
      signature: EXPECTED_SIGNATURE,
      rawBody: BODY,
      nowSeconds: 1700000000 + 6 * 60,
    }),
  ).toBe(false);
});

test("rejects missing headers", async () => {
  expect(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: null,
      signature: EXPECTED_SIGNATURE,
      rawBody: BODY,
      nowSeconds: 1700000000,
    }),
  ).toBe(false);
  expect(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: TIMESTAMP,
      signature: null,
      rawBody: BODY,
      nowSeconds: 1700000000,
    }),
  ).toBe(false);
});
