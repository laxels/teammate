import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfigContext, type DashboardConfig } from "./config";
import "./styles.css";

/**
 * Runtime config: /config.json is written next to the bundle on the fleet
 * host by scripts/deploy-dashboard.sh (the secret never ships in the repo or
 * the bundle). `bun run dev` falls back to VITE_CONVEX_URL +
 * VITE_DASHBOARD_SECRET from the environment.
 */
async function loadConfig(): Promise<DashboardConfig | null> {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (response.ok) {
      const parsed = (await response.json()) as Partial<DashboardConfig>;
      if (
        typeof parsed.convexUrl === "string" &&
        typeof parsed.secret === "string"
      ) {
        return { convexUrl: parsed.convexUrl, secret: parsed.secret };
      }
    }
  } catch {
    // fall through to env config
  }
  // DEV-only: in production builds this branch is statically eliminated, so
  // a VITE_DASHBOARD_SECRET present at build time can never be inlined into
  // the served bundle.
  if (import.meta.env.DEV) {
    const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
    const secret = import.meta.env.VITE_DASHBOARD_SECRET as string | undefined;
    if (convexUrl !== undefined && secret !== undefined) {
      return { convexUrl, secret };
    }
  }
  return null;
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("no #root element");
}
const root = createRoot(rootElement);

const config = await loadConfig();
if (config === null) {
  root.render(
    <div className="boot-error">
      <h1>Ultraclaude fleet</h1>
      <p>
        No configuration. Serve a <code>config.json</code> next to this page (
        <code>{"{ convexUrl, secret }"}</code>) — see
        scripts/deploy-dashboard.sh — or set VITE_CONVEX_URL and
        VITE_DASHBOARD_SECRET for local dev.
      </p>
    </div>,
  );
} else {
  const client = new ConvexReactClient(config.convexUrl);
  root.render(
    <StrictMode>
      <ConvexProvider client={client}>
        <ConfigContext.Provider value={config}>
          <App />
        </ConfigContext.Provider>
      </ConvexProvider>
    </StrictMode>,
  );
}
