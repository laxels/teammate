import { ConvexClient } from "convex/browser";
import type { HostVmPayload } from "../../shared/protocol";
import { loadConfig } from "./config";
import {
  provisionVmFailedRef,
  removeDevboxRef,
  startHostConsumer,
} from "./consumer";
import { createVmExecutors } from "./vm";

const config = loadConfig();
const client = new ConvexClient(config.convexUrl);

const executors = createVmExecutors({
  config,
  removeDevbox: async (devboxId) => {
    await client.mutation(removeDevboxRef, {
      devboxId,
      secret: config.devboxSharedSecret,
    });
  },
  reportProvisionFailure: async (devboxId, summary) => {
    await client.mutation(provisionVmFailedRef, {
      devboxId,
      summary,
      secret: config.devboxSharedSecret,
    });
  },
});

// Host provisioning is no longer a host-agent command — GitHub Actions
// bootstraps new Macs (#87, .github/workflows/provision-host.yml). The host
// agent only manages VMs on a host that is already up: provision_vm /
// destroy_vm.
startHostConsumer({
  client,
  hostId: config.hostId,
  secret: config.devboxSharedSecret,
  canProvisionHosts: config.canProvisionHosts,
  execute: async (command) => {
    const payload = JSON.parse(command.payload) as HostVmPayload;
    if (typeof payload?.devboxId !== "string") {
      throw new Error(
        `command ${command.commandId} has no devboxId in payload: ${command.payload}`,
      );
    }
    console.log(
      `[hostagent] executing ${command.kind} ${payload.devboxId} (command ${command.commandId})`,
    );
    if (command.kind === "provision_vm") {
      await executors.provision(payload.devboxId);
    } else {
      await executors.destroy(payload.devboxId);
    }
  },
});

console.log(
  `[hostagent] host ${config.hostId} consuming hostCommands from ${config.convexUrl} ` +
    `(golden image: ${config.goldenImage}, payload: ${config.payloadDir})`,
);
