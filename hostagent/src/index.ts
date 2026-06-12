import { ConvexClient } from "convex/browser";
import type {
  HostProvisionPayload,
  HostVmPayload,
} from "../../shared/protocol";
import { loadConfig } from "./config";
import {
  recordHostEventRef,
  removeDevboxRef,
  startHostConsumer,
} from "./consumer";
import { createHostProvisioner } from "./hostProvision";
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
});

const provisioner = createHostProvisioner({
  scriptPath: config.provisionScriptPath,
  workdir: config.payloadDir,
  fleetEnvFile: config.fleetEnvFile,
  recordEvent: async (event) => {
    await client.mutation(recordHostEventRef, {
      ...event,
      secret: config.devboxSharedSecret,
    });
  },
});

startHostConsumer({
  client,
  hostId: config.hostId,
  secret: config.devboxSharedSecret,
  canProvisionHosts: config.canProvisionHosts,
  execute: async (command) => {
    if (command.kind === "provision_host") {
      const payload = JSON.parse(command.payload) as HostProvisionPayload;
      if (typeof payload?.hostName !== "string") {
        throw new Error(
          `command ${command.commandId} has no hostName in payload: ${command.payload}`,
        );
      }
      if (!config.canProvisionHosts) {
        throw new Error(
          `command ${command.commandId}: this host is not a fleet provisioner (FLEET_PROVISIONER unset)`,
        );
      }
      console.log(
        `[hostagent] bootstrapping new host ${payload.hostName} (command ${command.commandId})`,
      );
      // Detached on purpose: the bootstrap takes tens of minutes and must not
      // block VM commands; progress streams to Convex as hostEvents.
      provisioner.start(payload.hostName);
      return;
    }
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
