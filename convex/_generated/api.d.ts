/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as devboxes from "../devboxes.js";
import type * as hosts from "../hosts.js";
import type * as http from "../http.js";
import type * as notify from "../notify.js";
import type * as orchestrator from "../orchestrator.js";
import type * as slack from "../slack.js";
import type * as staleness from "../staleness.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  commands: typeof commands;
  crons: typeof crons;
  devboxes: typeof devboxes;
  hosts: typeof hosts;
  http: typeof http;
  notify: typeof notify;
  orchestrator: typeof orchestrator;
  slack: typeof slack;
  staleness: typeof staleness;
  tasks: typeof tasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
