// Convex's runtime exposes environment variables via `process.env`
// (https://docs.convex.dev/production/environment-variables) but is not
// Node.js, so declare just that surface instead of pulling in @types/node.
declare const process: {
  env: Record<string, string | undefined>;
};
