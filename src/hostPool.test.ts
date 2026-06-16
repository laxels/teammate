import { describe, expect, test } from "bun:test";
import type { TaskStatus } from "../shared/protocol";
import {
  ephemeralGatewayUrl,
  HOST_PROVISION_STALE_MS,
  type HostRow,
  inflightProvision,
  nextHostName,
  pickHost,
  pickProvisioner,
  shouldRetireDevbox,
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

describe("shouldRetireDevbox", () => {
  const TERMINAL: TaskStatus[] = ["completed", "failed", "stopped"];
  const NON_TERMINAL: TaskStatus[] = ["queued", "running", "needs_input"];

  test("applied terminal statuses retire the devbox", () => {
    for (const incomingStatus of TERMINAL) {
      expect(
        shouldRetireDevbox({
          statusApplied: true,
          incomingStatus,
        }),
      ).toBe(true);
    }
  });

  test("non-terminal statuses never retire", () => {
    for (const incomingStatus of NON_TERMINAL) {
      expect(
        shouldRetireDevbox({
          statusApplied: true,
          incomingStatus,
        }),
      ).toBe(false);
    }
  });

  test("an unapplied event (late duplicate) does not retire again", () => {
    expect(
      shouldRetireDevbox({
        statusApplied: false,
        incomingStatus: "completed",
      }),
    ).toBe(false);
  });
});

describe("nextHostName", () => {
  test("numbers sequentially from the highest fleet host", () => {
    expect(nextHostName([])).toBe("ultraclaude-host-1");
    expect(nextHostName(["ultraclaude-host-1"])).toBe("ultraclaude-host-2");
    expect(nextHostName(["ultraclaude-host-2", "ultraclaude-host-7"])).toBe(
      "ultraclaude-host-8",
    );
  });

  test("ignores names outside the fleet convention", () => {
    expect(nextHostName(["maxs-macbook", "ultraclaude-host-3"])).toBe(
      "ultraclaude-host-4",
    );
  });
});

describe("inflightProvision", () => {
  const provisioning = (requestedAt: number): HostRow => ({
    hostId: "ultraclaude-host-2",
    maxVms: 2,
    status: "provisioning",
    lastSeenAt: requestedAt,
    provisionRequestedAt: requestedAt,
  });

  test("returns the fresh in-flight bootstrap", () => {
    const row = provisioning(1_000_000);
    expect(inflightProvision([row], 1_000_000 + 60_000)).toEqual(row);
  });

  test("ignores stale bootstraps so a dead one cannot wedge scaling", () => {
    const row = provisioning(0);
    expect(inflightProvision([row], HOST_PROVISION_STALE_MS + 1)).toBeNull();
  });

  test("ignores active hosts", () => {
    expect(
      inflightProvision(
        [{ hostId: "h", maxVms: 2, status: "active", lastSeenAt: 5 }],
        10,
      ),
    ).toBeNull();
  });
});

describe("pickProvisioner", () => {
  const base = { maxVms: 2, lastSeenAt: 1_000 };

  test("picks a fresh, active, credential-holding host", () => {
    expect(
      pickProvisioner({
        hosts: [
          { hostId: "plain", status: "active", ...base },
          {
            hostId: "fleet",
            status: "active",
            canProvisionHosts: true,
            ...base,
          },
        ],
        nowMs: 1_500,
        freshnessMs: 1_000,
      }),
    ).toBe("fleet");
  });

  test("rejects stale, draining, and provisioning hosts", () => {
    expect(
      pickProvisioner({
        hosts: [
          {
            hostId: "stale",
            status: "active",
            canProvisionHosts: true,
            maxVms: 2,
            lastSeenAt: 0,
          },
          {
            hostId: "draining",
            status: "draining",
            canProvisionHosts: true,
            ...base,
          },
        ],
        nowMs: 10_000,
        freshnessMs: 1_000,
      }),
    ).toBeNull();
  });
});
