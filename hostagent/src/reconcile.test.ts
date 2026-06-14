import { describe, expect, test } from "bun:test";
import { reconcileOrphanedProvisions } from "./reconcile";

describe("reconcileOrphanedProvisions", () => {
  test("a provisioner restart fails the bootstraps it left dangling", async () => {
    const calls: { provisionerHostId: string; secret: string }[] = [];
    const logs: string[] = [];
    const failed = await reconcileOrphanedProvisions({
      failOrphanedProvisions: async (args) => {
        calls.push(args);
        return { failed: ["ultraclaude-host-2"] };
      },
      hostId: "host-1",
      secret: "s3cret",
      canProvisionHosts: true,
      log: (message) => logs.push(message),
    });

    expect(failed).toEqual(["ultraclaude-host-2"]);
    expect(calls).toEqual([{ provisionerHostId: "host-1", secret: "s3cret" }]);
    // The freed host is named in the operator log.
    expect(logs.join("\n")).toContain("ultraclaude-host-2");
  });

  test("non-provisioner hosts never call the mutation", async () => {
    let called = false;
    const failed = await reconcileOrphanedProvisions({
      failOrphanedProvisions: async () => {
        called = true;
        return { failed: [] };
      },
      hostId: "devbox-host",
      secret: "s3cret",
      canProvisionHosts: false,
    });

    expect(failed).toEqual([]);
    expect(called).toBe(false);
  });

  test("nothing to free: empty result, nothing logged", async () => {
    const logs: string[] = [];
    const failed = await reconcileOrphanedProvisions({
      failOrphanedProvisions: async () => ({ failed: [] }),
      hostId: "host-1",
      secret: "s3cret",
      canProvisionHosts: true,
      log: (message) => logs.push(message),
    });

    expect(failed).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a Convex error is swallowed so the agent still comes up", async () => {
    const errors: unknown[] = [];
    const failed = await reconcileOrphanedProvisions({
      failOrphanedProvisions: async () => {
        throw new Error("convex unreachable");
      },
      hostId: "host-1",
      secret: "s3cret",
      canProvisionHosts: true,
      logError: (_message, error) => errors.push(error),
    });

    expect(failed).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
