import { describe, expect, test } from "bun:test";
import type { TaskStatus } from "../shared/protocol";
import {
  ephemeralGatewayUrl,
  type HostRow,
  pickHost,
  shouldRetireEphemeralDevbox,
} from "./hostPool";
import { monitoringUrl } from "./orchestration";

const MIN = 60_000;
const now = 1_750_000_000_000;
const FRESHNESS = 2 * MIN;

function host(overrides: Partial<HostRow> & { hostId: string }): HostRow {
  return { maxVms: 2, status: "active", lastSeenAt: now, ...overrides };
}

function counts(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe("pickHost", () => {
  test("picks an active fresh host with a free slot", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1" })],
        vmCountByHost: counts({ "host-1": 1 }),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBe("host-1");
  });

  test("a host with no devbox rows counts as zero VMs", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1" })],
        vmCountByHost: counts({}),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBe("host-1");
  });

  test("returns null when every host is at its VM cap", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1" }), host({ hostId: "host-2" })],
        vmCountByHost: counts({ "host-1": 2, "host-2": 2 }),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBeNull();
  });

  test("skips draining hosts even when they have free slots", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1", status: "draining" })],
        vmCountByHost: counts({}),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBeNull();
  });

  test("skips hosts with a stale heartbeat", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1", lastSeenAt: now - 3 * MIN })],
        vmCountByHost: counts({}),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBeNull();
    // Exactly at the freshness boundary still counts as alive.
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1", lastSeenAt: now - FRESHNESS })],
        vmCountByHost: counts({}),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBe("host-1");
  });

  test("respects per-host maxVms rather than a global cap", () => {
    expect(
      pickHost({
        hosts: [
          host({ hostId: "host-1", maxVms: 2 }),
          host({ hostId: "host-2", maxVms: 4 }),
        ],
        vmCountByHost: counts({ "host-1": 2, "host-2": 3 }),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBe("host-2");
  });

  test("spreads load: the least-loaded eligible host wins", () => {
    expect(
      pickHost({
        hosts: [host({ hostId: "host-1" }), host({ hostId: "host-2" })],
        vmCountByHost: counts({ "host-1": 1, "host-2": 0 }),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBe("host-2");
  });

  test("returns null for an empty host pool", () => {
    expect(
      pickHost({
        hosts: [],
        vmCountByHost: counts({}),
        nowMs: now,
        freshnessMs: FRESHNESS,
      }),
    ).toBeNull();
  });
});

describe("ephemeralGatewayUrl", () => {
  test("the monitoring URL derives cleanly from the deterministic gateway URL", () => {
    // Cross-contract check: the pre-created gatewayUrl must survive the same
    // monitoringUrl derivation used for status updates (Tailscale Serve 443).
    const gatewayUrl = ephemeralGatewayUrl(
      "devbox-eph-1a2b3c4d",
      "tail4d21c4.ts.net",
    );
    expect(gatewayUrl).toBe(
      "http://devbox-eph-1a2b3c4d.tail4d21c4.ts.net:8787",
    );
    expect(monitoringUrl(gatewayUrl)).toBe(
      "https://devbox-eph-1a2b3c4d.tail4d21c4.ts.net/",
    );
  });
});

describe("shouldRetireEphemeralDevbox", () => {
  const TERMINAL: TaskStatus[] = ["completed", "failed", "stopped"];
  const NON_TERMINAL: TaskStatus[] = ["queued", "running", "needs_input"];

  test("applied terminal statuses retire an ephemeral devbox", () => {
    for (const incomingStatus of TERMINAL) {
      expect(
        shouldRetireEphemeralDevbox({
          ephemeral: true,
          statusApplied: true,
          incomingStatus,
        }),
      ).toBe(true);
    }
  });

  test("non-terminal statuses never retire", () => {
    for (const incomingStatus of NON_TERMINAL) {
      expect(
        shouldRetireEphemeralDevbox({
          ephemeral: true,
          statusApplied: true,
          incomingStatus,
        }),
      ).toBe(false);
    }
  });

  test("permanent devboxes (ephemeral unset or false) never retire", () => {
    for (const ephemeral of [false, undefined]) {
      expect(
        shouldRetireEphemeralDevbox({
          ephemeral,
          statusApplied: true,
          incomingStatus: "completed",
        }),
      ).toBe(false);
    }
  });

  test("an unapplied event (late duplicate) does not retire again", () => {
    expect(
      shouldRetireEphemeralDevbox({
        ephemeral: true,
        statusApplied: false,
        incomingStatus: "completed",
      }),
    ).toBe(false);
  });
});
